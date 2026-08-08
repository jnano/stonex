import { Injectable } from '@nestjs/common';
import { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { OwnerCleanupHook, PurgeContext, PurgeResult } from '../authorization/owner-cleanup';

/**
 * domain 소유자 정리 훅 (WP-K2) — **신설**.
 *
 * 기존 회원 삭제는 파일만 정리하고 도메인은 남겼다(커널이 소유 자원을 열거하던 구조의
 * 알려진 결함). 탈퇴자의 도메인이 남으면 위임 Grant 보유자가 계속 접근하고, FQDN 이
 * 부분 유니크 인덱스에 잡혀 재등록도 막힌다. 훅 등록으로 정리 연쇄에 편입한다.
 */
@Injectable()
export class DomainOwnerCleanupHook implements OwnerCleanupHook {
  readonly type = 'domain';

  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: ResourceGrantService,
  ) {}

  async purgeOwnerDeleted(userId: string, context: PurgeContext, limit: number): Promise<PurgeResult> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const targets = await tx.domain.findMany({
        where: { owner_id: userId, deleted_at: null },
        select: { id: true },
        take: limit,
      });
      for (const t of targets) {
        await tx.domain.update({
          where: { id: t.id },
          data: { status: 'DELETED', deleted_at: new Date() },
        });
        await this.grants.cleanupForResource(tx, 'domain', t.id, context);
        // 진행 중 이전 제안이 남으면 수락 시점에 삭제된 도메인이 되살아나는 경로가 된다
        await tx.domainTransfer.updateMany({
          where: { domain_id: t.id, status: 'PENDING' },
          data: { status: 'INVALIDATED', reason: '소유자 탈퇴로 도메인이 정리되었습니다.', finished_at: new Date() },
        });
      }
      const remaining = await tx.domain.count({ where: { owner_id: userId, deleted_at: null } });
      return { purged: targets.length, remaining: remaining > 0 };
    });
  }
}
