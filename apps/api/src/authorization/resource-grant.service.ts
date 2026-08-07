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

  /** 리소스 삭제 시 해당 리소스를 가리키는 Grant 정리 (§5.3) — Phase 2 파일·도메인 삭제가 사용 */
  async cleanupForResource(
    tx: Prisma.TransactionClient,
    resourceType: string,
    resourceId: string,
  ): Promise<number> {
    const { count } = await tx.resourceGrant.deleteMany({
      where: { resource_type: resourceType, resource_id: resourceId },
    });
    return count;
  }
}
