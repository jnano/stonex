import { Injectable } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { AuditService } from '../audit/audit.service';

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
  constructor(private readonly audit: AuditService) {}

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
