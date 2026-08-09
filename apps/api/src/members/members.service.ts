import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RoleGrantService } from '../authorization/role-grant.service';
import { PermVersionService } from '../cache/perm-version.service';
import { SnapshotService } from '../authorization/snapshot.service';
import { randomBytes } from 'node:crypto';
import { checkDominance, checkRoleSubset } from '../authorization/dominance';
import { SubjectSnapshot } from '../authorization/types';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { PasswordService } from '../auth/password.service';
import { SuperAdminGuardService } from './super-admin-guard.service';
import { MemberDetail, MemberSummary, toMemberDetail, toMemberSummary } from './member.serializer';

const SUPER_ADMIN = 'SUPER_ADMIN';

export interface DominanceCheckResult {
  manageable: boolean;
  reason: string;
  /** 행위자에게 없어 관리를 막은 대상측 Permission (관리 콘솔 표시용 §4.6-3) */
  missing: string[];
}

/**
 * 회원 관리 (기획서 §6.2 MEM-1~6).
 *
 * 권한 검사는 Guard 가 이미 통과시켰다는 전제이며, 여기서는 **관계·불변식 규칙**을 담당한다:
 * 우위 검사(§4.6-1), 역할 부분집합 검사(§4.6-2), 최고관리자 보존(§10.1),
 * 세션 무효화(MEM-4/6), 감사 기록(INV-6).
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly roleGrants: RoleGrantService,
    private readonly permVersion: PermVersionService,
    private readonly snapshots: SnapshotService,
    private readonly superAdminGuard: SuperAdminGuardService,
    private readonly resourceGrants: ResourceGrantService,
    private readonly passwords: PasswordService,
  ) {}

  // ── MEM-2 목록·상세 ───────────────────────────────────────────
  async list(page = 1, size = 20): Promise<{ items: MemberSummary[]; total: number }> {
    const take = Math.min(Math.max(size, 1), 100);
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { deleted_at: null },
        orderBy: { created_at: 'desc' },
        skip: (Math.max(page, 1) - 1) * take,
        take,
      }),
      this.prisma.user.count({ where: { deleted_at: null } }),
    ]);
    return { items: rows.map(toMemberSummary), total };
  }

  async detail(userId: string): Promise<MemberDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { user_roles: { include: { role: true } } },
    });
    if (!user || user.deleted_at) throw new NotFoundException();
    return toMemberDetail(user, user.user_roles.map((ur) => ur.role.code));
  }

  /**
   * "이 회원을 관리할 수 있는가 + 불가 사유" (§4.6-3).
   * 관리 콘솔의 표시와 권한 시뮬레이터(ADM-5)가 같은 판정 로직을 재사용한다.
   */
  async dominanceCheck(actor: SubjectSnapshot, targetUserId: string): Promise<DominanceCheckResult> {
    const target = await this.snapshots.forUser(targetUserId);
    if (!target) throw new NotFoundException();
    const result = checkDominance(
      actor.id, new Set(actor.permissions.keys()),
      target.id, new Set(target.permissions.keys()),
    );
    const reasonText: Record<string, string> = {
      DOMINANT: '관리 가능',
      SELF_TARGET: '본인은 관리 대상이 될 수 없습니다',
      EQUAL_SET: '동급 관리자입니다 (권한 집합이 동일)',
      INCOMPARABLE: '대상이 보유한 권한 중 내가 갖지 못한 것이 있습니다',
      NOT_SUPERSET: '권한이 부족합니다',
    };
    return { manageable: result.allowed, reason: reasonText[result.reason], missing: result.missing };
  }

  /** 관리 행위 공통 전제: 우위 검사 통과 여부 확인 (Guard 와 이중 방어) */
  private async assertDominance(actor: SubjectSnapshot, targetUserId: string): Promise<void> {
    const check = await this.dominanceCheck(actor, targetUserId);
    if (!check.manageable) throw new ForbiddenException();
  }

  // ── MEM-7 회원 생성 (관리자 초대) ─────────────────────────────
  /**
   * 관리자가 회원 계정을 만든다.
   *
   * 비밀번호는 **임시값을 발급하고 최초 로그인 시 변경을 강제**한다(온보딩 §8.5) —
   * 관리자가 정한 비밀번호를 그대로 쓰게 두면 그 값을 아는 사람이 둘이 된다.
   * 역할은 **행위자가 가진 것만** 줄 수 있다(§4.6-2 부분집합) — 자기보다 강한 계정을
   * 만들어 권한을 우회하는 경로를 막는다.
   *
   * 임시 비밀번호는 응답으로 한 번만 돌려준다 — 저장하지 않으므로 다시 볼 수 없다.
   */
  async create(
    actor: SubjectSnapshot,
    input: { email: string; name: string; roleIds?: string[] },
  ): Promise<{ member: MemberDetail; temporaryPassword: string }> {
    const existing = await this.prisma.user.findUnique({
      where: { tenant_id_email: { tenant_id: actor.tenantId, email: input.email } },
    });
    if (existing) throw new BadRequestException('이미 사용 중인 이메일입니다.');

    const roles = input.roleIds?.length
      ? await this.prisma.role.findMany({
          where: { id: { in: [...new Set(input.roleIds)] }, tenant_id: actor.tenantId },
          include: { role_permissions: { include: { permission: true } } },
        })
      : [];
    if (roles.length !== (input.roleIds ? [...new Set(input.roleIds)].length : 0)) {
      throw new NotFoundException();
    }
    for (const role of roles) {
      // 부분집합 검사(§4.6-2) — 행위자가 못 가진 권한을 남에게 줄 수 없다
      const subset = checkRoleSubset(
        new Set(role.role_permissions.map((rp) => rp.permission.code)),
        new Set(actor.permissions.keys()),
      );
      if (!subset.allowed) throw new ForbiddenException();
    }

    const temporaryPassword = randomBytes(12).toString('base64url');
    const passwordHash = await this.passwords.hash(temporaryPassword);

    const created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const user = await tx.user.create({
        data: {
          tenant_id: actor.tenantId,
          email: input.email,
          name: input.name,
          password_hash: passwordHash,
          status: 'ACTIVE',
          // 온보딩 강제 — 임시 비밀번호를 그대로 쓰지 못하게 한다(§8.5)
          must_change_password: true,
        },
      });
      for (const role of roles) {
        await this.roleGrants.grant(tx, {
          tenantId: actor.tenantId, userId: user.id, roleId: role.id, roleCode: role.code,
          actorId: actor.id, expiresAt: null, before: { roles: [] },
        });
      }
      await this.audit.record(tx, {
        tenantId: actor.tenantId, actorId: actor.id, action: 'member.create',
        targetType: 'user', targetId: user.id,
        // 임시 비밀번호는 감사에 남기지 않는다 — 로그는 보존이 길고 회수가 어렵다
        detail: { before: {}, after: { email: user.email, roles: roles.map((r) => r.code) } },
      });
      return user;
    });
    return { member: await this.detail(created.id), temporaryPassword };
  }

  // ── MEM-3 회원 수정 ───────────────────────────────────────────
  async update(actor: SubjectSnapshot, targetUserId: string, data: { name?: string }): Promise<MemberDetail> {
    await this.assertDominance(actor, targetUserId);
    const before = await this.detail(targetUserId);

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.user.update({ where: { id: targetUserId }, data: { name: data.name } });
      await this.audit.record(tx, {
        tenantId: actor.tenantId, actorId: actor.id, action: 'member.update',
        targetType: 'user', targetId: targetUserId,
        detail: { before: { name: before.name }, after: { name: data.name } },
      });
    });
    return this.detail(targetUserId);
  }

  // ── MEM-4 정지/해제 ───────────────────────────────────────────
  /**
   * 정지 시: 최고관리자 보존 검사 → 상태 변경 + pv 증가 + 리프레시 패밀리 전체 폐기.
   * 활성 세션(Access)과 재발급 경로(Refresh)를 동시에 끊는다(§10.1).
   */
  async setBanned(actor: SubjectSnapshot, targetUserId: string, banned: boolean): Promise<MemberDetail> {
    await this.assertDominance(actor, targetUserId);
    const before = await this.detail(targetUserId);

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (banned) await this.superAdminGuard.ensureRemains(tx, targetUserId, actor.tenantId);

      await tx.user.update({
        where: { id: targetUserId },
        data: { status: banned ? 'SUSPENDED' : 'ACTIVE' },
      });
      if (banned) {
        await tx.refreshToken.updateMany({
          where: { user_id: targetUserId, revoked_at: null },
          data: { revoked_at: new Date() },
        });
      }
      await this.permVersion.bumpInTx(tx, [targetUserId]);
      await this.audit.record(tx, {
        tenantId: actor.tenantId, actorId: actor.id,
        action: banned ? 'member.ban' : 'member.unban',
        targetType: 'user', targetId: targetUserId,
        detail: { before: { status: before.status }, after: { status: banned ? 'SUSPENDED' : 'ACTIVE' } },
      });
    });
    await this.permVersion.flushCache([targetUserId]);
    return this.detail(targetUserId);
  }

  // ── MEM-5 역할 부여/회수 ──────────────────────────────────────
  /**
   * 부여: 우위 검사 + **부분집합 검사**(역할 집합 ⊆ 행위자 집합, §4.6-2).
   * requires_2fa 역할을 TOTP 미등록자에게 부여하면 즉시 세션을 끊고 재로그인+등록을 강제한다(RT-4·RT-7).
   * SUPER_ADMIN 에는 expires_at 을 지정할 수 없다(§4.5).
   */
  async grantRole(
    actor: SubjectSnapshot,
    targetUserId: string,
    roleId: string,
    expiresAt?: Date | null,
  ): Promise<MemberDetail> {
    await this.assertDominance(actor, targetUserId);
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { role_permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException();

    const subset = checkRoleSubset(
      new Set(role.role_permissions.map((rp) => rp.permission.code)),
      new Set(actor.permissions.keys()),
    );
    if (!subset.allowed) throw new ForbiddenException(); // 공모 계정을 통한 간접 상승 차단

    if (role.code === SUPER_ADMIN && expiresAt) {
      throw new BadRequestException('SUPER_ADMIN 에는 만료를 지정할 수 없습니다.');
    }

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException();
    const needsTotpEnrollment = role.requires_2fa && target.totp_secret === null;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.roleGrants.grant(tx, {
        tenantId: actor.tenantId, userId: targetUserId, roleId: role.id, roleCode: role.code,
        actorId: actor.id, expiresAt, before: { roles: [] },
      });
      if (needsTotpEnrollment) {
        // 온보딩 플래그 + refresh 폐기: "다음 로그인까지" 2FA 없이 관리 행위가 가능한 창을 없앤다
        await tx.user.update({
          where: { id: targetUserId },
          data: { totp_enrollment_required: true },
        });
        await tx.refreshToken.updateMany({
          where: { user_id: targetUserId, revoked_at: null },
          data: { revoked_at: new Date() },
        });
      }
    });
    await this.roleGrants.flushCache([targetUserId]);
    return this.detail(targetUserId);
  }

  /** 회수: 우위 + 부분집합 검사에 더해 최고관리자 보존 검사 */
  async revokeRole(actor: SubjectSnapshot, targetUserId: string, roleId: string): Promise<MemberDetail> {
    await this.assertDominance(actor, targetUserId);
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { role_permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException();

    const subset = checkRoleSubset(
      new Set(role.role_permissions.map((rp) => rp.permission.code)),
      new Set(actor.permissions.keys()),
    );
    if (!subset.allowed) throw new ForbiddenException();

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (role.code === SUPER_ADMIN) await this.superAdminGuard.ensureRemains(tx, targetUserId, actor.tenantId);
      await this.roleGrants.revoke(tx, {
        tenantId: actor.tenantId, userId: targetUserId, roleId: role.id,
        roleCode: role.code, actorId: actor.id,
      });
    });
    await this.roleGrants.flushCache([targetUserId]);
    return this.detail(targetUserId);
  }

  // ── MEM-6 회원 삭제 (소프트) ─────────────────────────────────
  /** 소프트 삭제 + 세션 폐기 + 해당 사용자가 subject 인 Grant 정리(§5.3) */
  async softDelete(actor: SubjectSnapshot, targetUserId: string): Promise<void> {
    await this.assertDominance(actor, targetUserId);
    const before = await this.detail(targetUserId);

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.superAdminGuard.ensureRemains(tx, targetUserId, actor.tenantId);

      await tx.user.update({
        where: { id: targetUserId },
        data: { status: 'DELETED', deleted_at: new Date() },
      });
      await tx.refreshToken.updateMany({
        where: { user_id: targetUserId, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      // 논리 참조라 FK CASCADE 가 없다 — 전용 통로에서 정리 + 감사(§5.3)
      await this.resourceGrants.cleanupForSubject(tx, targetUserId, {
        tenantId: actor.tenantId, actorId: actor.id,
      });
      // MEM-6: 그 회원이 **소유한** 리소스도 처리한다(WT-17). 소유 리소스를 남겨두면
      // 기존 ALLOW Grant 보유자가 평가기 4단계로 무기한 접근할 수 있고, RI-4 로도 잡히지 않는다.
      //
      // WP-K2: 여기서는 퍼지 잡 1건만 넣는다(O(1)) — 보유량에 비례하는 쓰기를 트랜잭션에
      // 넣으면 SuperAdminGuard 의 FOR UPDATE 와 경합한다(RT-27). 은닉은 위의
      // deleted_at 표식이 **즉시** 담당하므로 가시성 창은 없다(DEC-3) — 로더와 목록이
      // 소유자 삭제를 보고 커밋 직후부터 404/제외 처리한다. 실제 소프트삭제·Grant 정리는
      // OwnerCleanupWorker 가 등록된 훅(file·domain·…)을 배치로 호출해 이어받는다.
      // 어떤 리소스 타입이 있는지 이 파일은 더 이상 모른다.
      await tx.ownerCleanupJob.create({
        data: { tenant_id: actor.tenantId, user_id: targetUserId },
      });
      await this.permVersion.bumpInTx(tx, [targetUserId]);
      await this.audit.record(tx, {
        tenantId: actor.tenantId, actorId: actor.id, action: 'member.delete',
        targetType: 'user', targetId: targetUserId,
        detail: { before: { status: before.status }, after: { status: 'DELETED' } },
      });
    });
    await this.permVersion.flushCache([targetUserId]);
  }

  // ── MEM-1 내 프로필 ───────────────────────────────────────────
  async myProfile(userId: string): Promise<MemberDetail> {
    return this.detail(userId);
  }

  async updateMyProfile(userId: string, data: { name?: string }): Promise<MemberDetail> {
    await this.prisma.user.update({ where: { id: userId }, data: { name: data.name } });
    return this.detail(userId);
  }
}
