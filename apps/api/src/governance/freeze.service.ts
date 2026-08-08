import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { PERMISSIONS } from '../../../../db/seeds/permissions';

/**
 * 동결이 막는 행위 = **권한을 이동시키는 Permission 집합** (§14.4).
 *
 * 라우트 목록으로 정의하면 새 API 를 추가할 때 조용히 누락된다 — 그래서 Permission 으로 정의하고,
 * 아래 규칙으로 **시드에서 기계적으로 도출**한다. 신규 Permission 이 이 규칙에 걸리면
 * 자동으로 동결 대상이 되고, 걸리지 않는데 대상이어야 한다면 여기 명시 목록에 추가한다.
 *
 * 규칙: 공유·위임(`*.share`, `*.share.all`) + 역할 부여 + 역할·권한 매핑 편집.
 * 파일 업로드나 도메인 등록처럼 **자기 리소스를 만드는 행위는 대상이 아니다** —
 * 동결의 취지는 "서비스 이용은 유지하되 권한만 못 옮기게"이기 때문이다.
 */
const EXPLICIT_FROZEN = ['member.role.assign', 'admin.role.manage', 'governance.freeze.manage'];

export const FROZEN_PERMISSIONS: ReadonlySet<string> = new Set([
  ...PERMISSIONS.map((p) => p.code).filter((code) => /\.share(\.all)?$/.test(code)),
  ...EXPLICIT_FROZEN,
]);

export interface FreezeSummary {
  id: string;
  userId: string;
  trigger: string;
  reason: string;
  status: string;
  frozenAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

/**
 * L-2 권한 변경 동결 (기획서 §14.4).
 *
 * **계정 정지와 다른 축이다.** 동결된 계정은 로그인하고 파일을 올리고 도메인을 쓸 수 있지만,
 * 권한을 남에게 옮기는 행위만 막힌다. 이상 정황에 대한 대응이 곧 서비스 중단이 되면
 * 오탐 한 번의 비용이 너무 커서 아무도 자동 대응을 켜지 않게 된다.
 */
@Injectable()
export class GovernanceFreezeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 이 Permission 이 동결의 대상인가 */
  static isFrozenScope(permissionCode: string): boolean {
    return FROZEN_PERMISSIONS.has(permissionCode);
  }

  /**
   * 권한 변경 서비스 진입부의 공통 선행 검사.
   *
   * `actorId=null` 은 시스템 행위(순찰의 자동 회수)라 대상이 아니다 — 시스템을 동결하면
   * 이상 상황에서 정리 자체가 멈춘다.
   *
   * 거부는 **403 + 명시 사유**다. 404 로 숨기지 않는 이유는, 본인에게까지 숨기면
   * "왜 안 되는지 모르겠다"는 문의만 늘고 조치가 늦어지기 때문이다(§14.4).
   */
  async assertNotFrozen(actorId: string | null): Promise<void> {
    if (!actorId) return;
    const freeze = await this.prisma.governanceFreeze.findFirst({
      where: { user_id: actorId, status: 'ACTIVE' },
      select: { trigger: true, reason: true },
    });
    if (freeze) {
      throw new ForbiddenException(
        `권한 변경이 동결된 계정입니다(${freeze.trigger}): ${freeze.reason}. ` +
          '해제는 다른 최고관리자의 승인이 필요합니다.',
      );
    }
  }

  /** 동결 발동. 이미 활성 동결이 있으면 그것을 그대로 돌려준다(멱등) */
  async freeze(input: {
    tenantId: string;
    userId: string;
    trigger: string;
    reason: string;
    actorId: string | null;
  }): Promise<FreezeSummary> {
    const existing = await this.prisma.governanceFreeze.findFirst({
      where: { user_id: input.userId, status: 'ACTIVE' },
    });
    if (existing) return this.toSummary(existing);

    const created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.governanceFreeze.create({
        data: {
          tenant_id: input.tenantId, user_id: input.userId,
          trigger: input.trigger, reason: input.reason.slice(0, 300), status: 'ACTIVE',
        },
      });
      // 거버넌스 이벤트 자체가 감사 대상이다(§14.4 — 감시자도 감사 대상)
      await this.audit.record(tx, {
        tenantId: input.tenantId, actorId: input.actorId, action: 'governance.freeze',
        targetType: 'user', targetId: input.userId,
        detail: { before: {}, after: { trigger: input.trigger, reason: input.reason } },
      });
      return row;
    });
    return this.toSummary(created);
  }

  /**
   * 동결 해제 — **피동결자 본인은 승인할 수 없다**(§14.4).
   * 승인자는 `governance.freeze.manage` 보유자(SUPER_ADMIN 전용 배정)여야 하며,
   * 게이트는 컨트롤러가 선언한다. 여기서는 관계 조건만 판정한다.
   */
  async release(subject: SubjectSnapshot, freezeId: string, note?: string): Promise<FreezeSummary> {
    const freeze = await this.prisma.governanceFreeze.findUnique({ where: { id: freezeId } });
    if (!freeze || freeze.status !== 'ACTIVE') throw new NotFoundException();

    if (freeze.user_id === subject.id) {
      // 자기 동결을 스스로 푸는 것을 허용하면 L-2 는 아무것도 막지 못한다
      throw new ForbiddenException('자신의 동결은 스스로 해제할 수 없습니다. 다른 최고관리자의 승인이 필요합니다.');
    }
    // 승인 가능한 사람이 실제로 남아 있는지 확인한다 — 0명이면 break-glass 절차로 넘긴다
    const approvers = await this.countEligibleApprovers(freeze.tenant_id, freeze.user_id);
    if (approvers === 0) {
      throw new ForbiddenException(
        '승인 가능한 활성 최고관리자가 없습니다. break-glass 런북 절차로 진행하세요 ' +
          '(docs/권한 관리 웹 애플리케이션 기획서/break-glass-runbook-v1.md).',
      );
    }

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.governanceFreeze.update({
        where: { id: freezeId },
        data: {
          status: 'RELEASED', released_at: new Date(), released_by: subject.id,
          release_note: note?.slice(0, 300) ?? null,
        },
      });
      await this.audit.record(tx, {
        tenantId: freeze.tenant_id, actorId: subject.id, action: 'governance.freeze.release',
        targetType: 'user', targetId: freeze.user_id,
        detail: {
          before: { status: 'ACTIVE', trigger: freeze.trigger },
          after: { status: 'RELEASED', note: note ?? null },
        },
      });
      return row;
    });
    return this.toSummary(updated);
  }

  /** 피동결자를 제외한 활성 SUPER_ADMIN 수 (WT-12) */
  async countEligibleApprovers(tenantId: string, frozenUserId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(DISTINCT u.id) AS n
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
       WHERE u.tenant_id = ${tenantId}::uuid
         AND u.id <> ${frozenUserId}::uuid
         AND u.status = 'ACTIVE'
         AND u.deleted_at IS NULL
         AND r.code = 'SUPER_ADMIN'
         AND (ur.expires_at IS NULL OR ur.expires_at > now())`;
    return Number(rows[0]?.n ?? 0);
  }

  async list(tenantId: string, includeReleased = false): Promise<FreezeSummary[]> {
    const rows = await this.prisma.governanceFreeze.findMany({
      where: { tenant_id: tenantId, ...(includeReleased ? {} : { status: 'ACTIVE' }) },
      orderBy: { frozen_at: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toSummary(r));
  }

  private toSummary(row: {
    id: string; user_id: string; trigger: string; reason: string; status: string;
    frozen_at: Date; released_at: Date | null; released_by: string | null;
  }): FreezeSummary {
    return {
      id: row.id,
      userId: row.user_id,
      trigger: row.trigger,
      reason: row.reason,
      status: row.status,
      frozenAt: row.frozen_at.toISOString(),
      releasedAt: row.released_at?.toISOString() ?? null,
      releasedBy: row.released_by,
    };
  }
}
