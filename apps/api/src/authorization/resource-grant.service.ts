import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { AuditService } from '../audit/audit.service';
import { GovernanceFreezeService } from '../governance/freeze.service';
import { GRANT_WHITELIST } from '../../../../db/seeds/permissions';
import { ResourceTypeRegistry } from './resource-registry';

/**
 * 리소스 Grant 변경의 유일한 통로 (기획서 §5.3, §4.4 화이트리스트).
 *
 * resource_grants 를 직접 조작하는 코드는 G-2(Semgrep authz-bypass-resource-grants)가 차단한다.
 * 이 서비스만 예외이며, 여기서 정리·회수가 감사 기록과 함께 이뤄진다.
 * Phase 2의 공유 생성/회수(FILE-4/5, DOM-5)도 이 서비스에 함수를 추가해 구현한다 —
 * 그때 화이트리스트 검증(§5.3)도 여기서 수행한다.
 */
@Injectable()
export class ResourceGrantService {
  constructor(
    private readonly audit: AuditService,
    private readonly freeze: GovernanceFreezeService,
    private readonly registry: ResourceTypeRegistry,
  ) {}

  /**
   * 사용자 삭제 시 그 사용자가 subject 인 Grant 전체 정리 (§5.3 — 논리 참조라 FK CASCADE 불가).
   * 정리 건수를 감사에 남겨, 나중에 "왜 이 공유가 사라졌는가"를 추적할 수 있게 한다.
   */
  async cleanupForSubject(
    tx: Prisma.TransactionClient,
    subjectId: string,
    context: { tenantId: string; actorId: string | null },
  ): Promise<number> {
    const { count } = await tx.resourceGrant.deleteMany({ where: { subject_id: subjectId } });
    if (count > 0) {
      await this.audit.record(tx, {
        tenantId: context.tenantId,
        actorId: context.actorId,
        action: 'grant.cleanup',
        targetType: 'user',
        targetId: subjectId,
        detail: { before: { grants: count }, after: { grants: 0 } },
      });
    }
    return count;
  }

  /**
   * Grant 생성 (기획서 §4.4·§5.3) — **리소스 Grant 를 만드는 유일한 통로**.
   *
   * 여기 모인 검증들은 각각 구체적인 공격 경로를 막는다.
   *  - 화이트리스트: `{type}.share` 가 빠져 있어 **재공유·재위임 전파**가 원천 차단된다(§10.1)
   *  - 관리자 부여 범위 제한: `file.share.all` 로 만드는 Grant 는 `file.read` 만 — 그렇지 않으면
   *    존재하지 않는 `file.update.all` 을 리소스 단위로 환전하게 된다(WT-3)
   *  - 자기부여 금지: 자신을 subject 로 하는 ALLOW Grant 는 만들 수 없다(§4.6-1 과 동형)
   *  - `effect` 고정: 입력으로 받지 않는다. DENY 는 §9.6 요구가 실제 발생할 때 별도 통로로(WT-5)
   *  - 예약 필드 차단: `subject_type`·`conditions` 를 입력으로 받지 않는다 — 미리 열어두면
   *    §9.4 활성화 순간 과거에 심어진 행이 일제히 발효된다(WT-24)
   *  - 행 잠금: 대상 리소스를 `FOR UPDATE` 로 잠근 뒤 검증한다. 잠금이 없으면 소유자 이전·삭제와
   *    경합할 때 정리를 빠져나간 Grant 가 남는다(WT-10)
   */
  async create(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      actorId: string;
      subjectId: string;
      resourceType: string;
      resourceId: string;
      permissionCodes: string[];
      expiresAt?: Date | null;
      /** 관리자 경로(`{type}.share.all`)로 생성하는가 — 부여 범위가 좁아진다 */
      viaAdminPath?: boolean;
    },
  ): Promise<number> {
    // L-2 동결 선행 검사 (§14.4). Guard 가 HTTP 경로를 막지만, 서비스 진입부에도 둔다 —
    // Grant 를 만드는 통로는 여기 하나뿐이라 이 지점이 최종 방어선이다.
    await this.freeze.assertNotFrozen(input.actorId);
    if (input.subjectId === input.actorId) {
      // 공모 계정 우회까지 막지는 못하지만(§4.6-2 의 Grant 판이 없다), 가장 단순한 자가발급은 끊는다
      throw new ForbiddenException('자신에게 Grant 를 부여할 수 없습니다.');
    }

    const allowed = GRANT_WHITELIST[input.resourceType];
    if (!allowed) throw new BadRequestException(`Grant 를 지원하지 않는 리소스 타입입니다: ${input.resourceType}`);

    const requested = [...new Set(input.permissionCodes)];
    if (requested.length === 0) throw new BadRequestException('부여할 권한이 없습니다.');
    const outside = requested.filter((c) => !allowed.includes(c));
    if (outside.length > 0) {
      throw new ForbiddenException(`Grant 로 부여할 수 없는 권한입니다: ${outside.join(', ')}`);
    }
    if (input.viaAdminPath) {
      const adminAllowed = requested.filter((c) => c === `${input.resourceType}.read`);
      if (adminAllowed.length !== requested.length) {
        throw new ForbiddenException(
          `관리자 경로로는 ${input.resourceType}.read 만 부여할 수 있습니다(§4.4).`,
        );
      }
    }

    // 대상 리소스 행을 잠그고 **잠근 뒤 상태를 재검증한다**(WT-10).
    // 잠금만 걸고 검증을 생략하면, 삭제·이전 트랜잭션이 먼저 커밋된 경우 이 트랜잭션은
    // 잠금을 넘겨받은 뒤 **이미 삭제된 리소스에 Grant 를 심는다** — 삭제 시 정리를 빠져나간
    // Grant 가 영구히 남는다(테스트로 실제 재현됨).
    //
    // 잠글 테이블은 레지스트리 서술자가 정한다(WP-K1). 기존 `file ? 'files' : 'domains'`
    // 삼항식은 세 번째 타입이 오면 엉뚱한 테이블을 잠그는 잠복 결함이었다(RT-23).
    // table 은 등록 시 식별자 검증 + 부팅 시 스키마 대조를 통과한 값이다(RT-26).
    const descriptor = this.registry.get(input.resourceType);
    if (!descriptor) {
      // GRANT_WHITELIST 는 통과했지만 서술자가 없는 타입 — 시드와 레지스트리가 어긋난 상태.
      // 조용히 넘어가면 잠금 없는 Grant 가 생기므로 명시적으로 거부한다.
      throw new BadRequestException(`리소스 서술자가 등록되지 않은 타입입니다: ${input.resourceType}`);
    }
    const table = descriptor.table;
    const locked = await tx.$queryRawUnsafe<Array<{ tenant_id: string; deleted_at: Date | null; status: string }>>(
      `SELECT tenant_id, deleted_at, status FROM ${table} WHERE id = $1::uuid FOR UPDATE`,
      input.resourceId,
    );
    if (locked.length === 0 || locked[0].deleted_at !== null) {
      throw new NotFoundException(); // 존재 은닉(§10.2)
    }
    if (locked[0].tenant_id !== input.tenantId) {
      // 논리 참조라 FK 가 없다 — 이 검증이 유일한 방어선이다(§5.3)
      throw new NotFoundException();
    }

    const perms = await tx.permission.findMany({ where: { code: { in: requested } } });
    if (perms.length !== requested.length) throw new BadRequestException('존재하지 않는 Permission 코드가 있습니다.');

    let created = 0;
    for (const perm of perms) {
      // 동일 (주체·리소스·권한) 조합이 이미 있으면 건드리지 않는다.
      // UNIQUE 가 effect 를 제외하므로(§5.2), UPSERT 로 짜면 기존 DENY 를 조용히 ALLOW 로
      // 덮어써 관리자가 걸어둔 차단이 정상 공유 요청 하나에 해제된다(WT-6).
      const existing = await tx.resourceGrant.findFirst({
        where: {
          subject_type: 'USER', subject_id: input.subjectId,
          resource_type: input.resourceType, resource_id: input.resourceId,
          permission_id: perm.id,
        },
        select: { id: true, effect: true },
      });
      if (existing) {
        if (existing.effect === 'DENY') {
          throw new ConflictException('해당 대상에 차단(DENY)이 설정되어 있어 공유할 수 없습니다.');
        }
        continue; // 이미 ALLOW — 멱등 처리
      }
      await tx.resourceGrant.create({
        data: {
          tenant_id: input.tenantId,
          subject_type: 'USER', // 예약 필드는 입력받지 않고 고정한다(WT-24)
          subject_id: input.subjectId,
          resource_type: input.resourceType,
          resource_id: input.resourceId,
          permission_id: perm.id,
          effect: 'ALLOW', // 입력으로 받지 않는다(WT-5)
          granted_by: input.actorId,
          expires_at: input.expiresAt ?? null,
        },
      });
      created += 1;
    }

    if (created > 0) {
      await this.audit.record(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'grant.create',
        targetType: input.resourceType,
        targetId: input.resourceId,
        detail: {
          before: {},
          after: {
            subject: input.subjectId,
            permissions: requested,
            expiresAt: input.expiresAt?.toISOString() ?? null,
            viaAdminPath: input.viaAdminPath === true,
          },
        },
      });
    }
    return created;
  }

  /**
   * Grant 회수 — 회수된 행 내용을 감사에 남긴다(누가 언제 무엇을 끊었는지 추적).
   *
   * `actorId=null` 은 시스템 행위(순찰 워커의 L-1 자동 회수)를 뜻하며, 그때는 `reason` 에
   * 어느 불변식이 왜 끊었는지를 담는다. **회수 전 행 전체를 `detail.before` 에 남기는 것이
   * 복구 스크립트의 유일한 근거**이므로 필드를 줄이지 않는다.
   */
  async revoke(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; actorId: string | null; grantId: string; reason?: string },
  ): Promise<void> {
    await this.freeze.assertNotFrozen(input.actorId);
    const grant = await tx.resourceGrant.findUnique({ where: { id: input.grantId } });
    if (!grant) throw new NotFoundException();

    await tx.resourceGrant.delete({ where: { id: input.grantId } });
    await this.audit.record(tx, {
      tenantId: input.tenantId,
      actorId: input.actorId,
      action: 'grant.revoke',
      targetType: grant.resource_type,
      targetId: grant.resource_id,
      detail: {
        before: {
          id: grant.id,
          tenantId: grant.tenant_id,
          subjectType: grant.subject_type,
          subject: grant.subject_id,
          resourceType: grant.resource_type,
          resourceId: grant.resource_id,
          permissionId: grant.permission_id,
          effect: grant.effect,
          grantedBy: grant.granted_by,
          expiresAt: grant.expires_at?.toISOString() ?? null,
        },
        after: {},
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
  }

  /**
   * 리소스 삭제·소유자 이전 시 해당 리소스를 가리키는 Grant 정리 (§5.3).
   *
   * **삭제되는 행 전체를 `detail.before` 에 담아 감사 기록한다**(CR-3·WT-9). 기록이 없으면
   * "왜 이 공유가 사라졌는가"를 추적할 수 없고, 삭제를 가장한 공유 말소가 감사에 남지 않는다.
   * 감사 기록 실패 시 예외가 전파되어 삭제도 함께 롤백된다(INV-6).
   *
   * `keepDeny=true` 이면 ALLOW Grant 만 삭제하고 DENY 는 승계한다 — DENY 는 §9.6의 제재
   * 수단이므로, 소유권 이전 때 함께 지우면 소유권 왕복만으로 차단이 해제된다(기획서 DOM-6).
   */
  async cleanupForResource(
    tx: Prisma.TransactionClient,
    resourceType: string,
    resourceId: string,
    context: { tenantId: string; actorId: string | null; keepDeny?: boolean },
  ): Promise<number> {
    const where = {
      resource_type: resourceType,
      resource_id: resourceId,
      ...(context.keepDeny ? { effect: 'ALLOW' } : {}),
    };
    // 삭제 전 행 내용을 확보한다 — 복구 근거이자 감사의 실질이다
    const doomed = await tx.resourceGrant.findMany({
      where,
      select: {
        id: true, subject_type: true, subject_id: true, permission_id: true,
        effect: true, granted_by: true, expires_at: true,
      },
    });
    if (doomed.length === 0) return 0;

    await tx.resourceGrant.deleteMany({ where });
    await this.audit.record(tx, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      action: 'grant.cleanup',
      targetType: resourceType,
      targetId: resourceId,
      detail: {
        before: { grants: doomed.map((g) => ({ ...g, expires_at: g.expires_at?.toISOString() ?? null })) },
        after: { grants: [] },
        keepDeny: context.keepDeny === true,
      },
    });
    return doomed.length;
  }
}
