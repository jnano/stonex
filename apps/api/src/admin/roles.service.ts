import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GovernanceFreezeService } from '../governance/freeze.service';
import { PermVersionService } from '../cache/perm-version.service';
import { SubjectSnapshot } from '../authorization/types';

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  requires2fa: boolean;
  isSystem: boolean;
  holderCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissions: Array<{ code: string; scope: string; description: string }>;
}

/**
 * 역할·매핑 관리 (기획서 §6.5 ADM-1~3).
 *
 * 권한 파워 통제의 핵심은 ADM-3 의 규칙이다:
 * **자신이 보유하지 않은 Permission 은 어떤 역할에도 부여할 수 없다**(§10.1).
 * 이 규칙이 없으면 "강한 권한을 담은 역할을 만들어 취득"하는 상승 경로가 열린다.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permVersion: PermVersionService,
    private readonly freeze: GovernanceFreezeService,
  ) {}

  // ── ADM-1 조회 ────────────────────────────────────────────────
  async list(tenantId: string): Promise<RoleSummary[]> {
    const roles = await this.prisma.role.findMany({
      where: { tenant_id: tenantId },
      orderBy: [{ display_order: 'asc' }, { code: 'asc' }], // 정렬 용도 — 보안 판정 아님(INV-2)
      include: { _count: { select: { user_roles: true } } },
    });
    return roles.map((r) => ({
      id: r.id, code: r.code, name: r.name,
      displayOrder: r.display_order, requires2fa: r.requires_2fa, isSystem: r.is_system,
      holderCount: r._count.user_roles,
    }));
  }

  async detail(roleId: string): Promise<RoleDetail> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: {
        role_permissions: { include: { permission: true } },
        _count: { select: { user_roles: true } },
      },
    });
    if (!role) throw new NotFoundException();
    return {
      id: role.id, code: role.code, name: role.name,
      displayOrder: role.display_order, requires2fa: role.requires_2fa, isSystem: role.is_system,
      holderCount: role._count.user_roles,
      permissions: role.role_permissions.map((rp) => ({
        code: rp.permission.code, scope: rp.permission.scope, description: rp.permission.description,
      })),
    };
  }

  /** 선택 가능한 Permission 목록. 행위자 보유분만 노출하여 UI 단계에서 오해를 줄인다(실제 통제는 ADM-3) */
  async assignablePermissions(actor: SubjectSnapshot) {
    const all = await this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
    return all.map((p) => ({
      code: p.code, scope: p.scope, description: p.description, module: p.module,
      assignable: actor.permissions.has(p.code),
    }));
  }

  // ── ADM-2 생성·수정·삭제 ─────────────────────────────────────
  async create(
    actor: SubjectSnapshot,
    input: { code: string; name: string; displayOrder?: number; requires2fa?: boolean },
  ): Promise<RoleDetail> {
    const exists = await this.prisma.role.findUnique({
      where: { tenant_id_code: { tenant_id: actor.tenantId, code: input.code } },
    });
    if (exists) throw new ConflictException('이미 존재하는 역할 코드입니다.');

    const role = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.role.create({
        data: {
          tenant_id: actor.tenantId, code: input.code, name: input.name,
          display_order: input.displayOrder ?? 0,
          requires_2fa: input.requires2fa ?? false,
          is_system: false, // 시스템 역할은 시드로만 생성된다(§10.3)
        },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId, actorId: actor.id, action: 'role.create',
        targetType: 'role', targetId: created.id,
        detail: { before: {}, after: { code: created.code, requires2fa: created.requires_2fa } },
      });
      return created;
    });
    return this.detail(role.id);
  }

  /** 수정: is_system 역할은 코드 변경 금지(§10.3). requires_2fa 변경도 감사 대상(§10.4) */
  async update(
    actor: SubjectSnapshot,
    roleId: string,
    input: { name?: string; displayOrder?: number; requires2fa?: boolean },
  ): Promise<RoleDetail> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException();

    const affected = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.role.update({
        where: { id: roleId },
        data: {
          name: input.name,
          display_order: input.displayOrder,
          requires_2fa: input.requires2fa,
        },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId, actorId: actor.id, action: 'role.update',
        targetType: 'role', targetId: roleId,
        detail: {
          before: { name: role.name, displayOrder: role.display_order, requires2fa: role.requires_2fa },
          after: input,
        },
      });
      // 2FA 요구가 새로 켜지면 보유자의 세션을 끊어 재로그인+등록을 강제한다(RT-4 정신)
      if (input.requires2fa === true && !role.requires_2fa) {
        const holders = await tx.userRole.findMany({ where: { role_id: roleId }, select: { user_id: true } });
        const ids = holders.map((h) => h.user_id);
        await tx.user.updateMany({
          where: { id: { in: ids }, totp_secret: null },
          data: { totp_enrollment_required: true },
        });
        await tx.refreshToken.updateMany({
          where: { user_id: { in: ids }, revoked_at: null },
          data: { revoked_at: new Date() },
        });
        await this.permVersion.bumpInTx(tx, ids);
        return ids;
      }
      return [];
    });
    if (affected.length > 0) await this.permVersion.flushCache(affected);
    return this.detail(roleId);
  }

  /** 삭제: is_system 금지 + 보유자 존재 시 거부(선 회수, 후 삭제 — §10.3) */
  async remove(actor: SubjectSnapshot, roleId: string): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { user_roles: true } } },
    });
    if (!role) throw new NotFoundException();
    if (role.is_system) throw new ForbiddenException('시스템 역할은 삭제할 수 없습니다.');
    if (role._count.user_roles > 0) {
      throw new ConflictException('보유자가 있는 역할은 삭제할 수 없습니다. 먼저 회수하세요.');
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.role.delete({ where: { id: roleId } });
      await this.audit.record(tx, {
        tenantId: actor.tenantId, actorId: actor.id, action: 'role.delete',
        targetType: 'role', targetId: roleId,
        detail: { before: { code: role.code }, after: {} },
      });
    });
  }

  /** 역할 복제 (상속 대신 제공 — §4.5). 매핑도 함께 복사하되 행위자 보유분만 허용된다 */
  async duplicate(actor: SubjectSnapshot, roleId: string, newCode: string, newName: string): Promise<RoleDetail> {
    const source = await this.detail(roleId);
    const created = await this.create(actor, {
      code: newCode, name: newName,
      displayOrder: source.displayOrder, requires2fa: source.requires2fa,
    });
    return this.setPermissions(actor, created.id, source.permissions.map((p) => p.code));
  }

  // ── ADM-3 매핑 편집 (전체 치환) ───────────────────────────────
  /**
   * 역할의 Permission 집합을 통째로 교체한다.
   *
   * **행위자가 보유하지 않은 Permission 은 부여할 수 없다**(§10.1 — 권한 상승 차단).
   * 기존 매핑 중 행위자가 보유하지 않은 것을 제거하는 것은 허용한다(약화는 상승이 아니다).
   * 변경 후 보유자 전원의 pv 를 배치 증가시키고 캐시를 삭제한다(§8.3).
   */
  async setPermissions(actor: SubjectSnapshot, roleId: string, codes: string[]): Promise<RoleDetail> {
    // L-2 동결 선행 검사 (§14.4) — 매핑 편집은 역할 하나로 다수의 권한을 한꺼번에 옮긴다
    await this.freeze.assertNotFrozen(actor.id);
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { role_permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException();

    const requested = [...new Set(codes)];
    const current = new Set(role.role_permissions.map((rp) => rp.permission.code));
    const added = requested.filter((c) => !current.has(c));
    const notOwned = added.filter((c) => !actor.permissions.has(c));
    if (notOwned.length > 0) {
      throw new ForbiddenException(
        `보유하지 않은 권한은 부여할 수 없습니다: ${notOwned.join(', ')}`,
      );
    }

    const perms = await this.prisma.permission.findMany({ where: { code: { in: requested } } });
    if (perms.length !== requested.length) throw new BadRequestException('존재하지 않는 Permission 코드가 있습니다.');

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.rolePermission.deleteMany({ where: { role_id: roleId } });
      if (perms.length > 0) {
        await tx.rolePermission.createMany({
          data: perms.map((p) => ({
            tenant_id: role.tenant_id, role_id: roleId, permission_id: p.id, granted_by: actor.id,
          })),
        });
      }
      await this.audit.record(tx, {
        tenantId: actor.tenantId, actorId: actor.id, action: 'role.permissions.replace',
        targetType: 'role', targetId: roleId,
        detail: { before: { permissions: [...current] }, after: { permissions: requested } },
      });
    });

    // 매핑 변경은 보유자 전원의 유효 권한을 바꾼다 — pv 배치 증가 + 캐시 삭제(§8.3)
    await this.permVersion.invalidateRoleHolders(roleId);
    return this.detail(roleId);
  }
}
