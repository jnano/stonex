import { Injectable } from '@nestjs/common';
import { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { OwnerCleanupHook, PurgeContext, PurgeResult } from '../authorization/owner-cleanup';

/**
 * file 소유자 정리 훅 (WP-K2).
 *
 * members.service 가 직접 부르던 FilesService.softDeleteOwnedBy 의 후신이다 —
 * 같은 일(소프트삭제 + Grant 정리)을 회원 삭제 트랜잭션 밖에서 배치로 한다(RT-27).
 * 소유자 삭제 시점부터 파일은 로더·목록에서 이미 은닉되어 있으므로(DEC-3),
 * 여기서의 지연은 가시성이 아니라 저장 공간·불변식 정합의 문제다.
 */
@Injectable()
export class FileOwnerCleanupHook implements OwnerCleanupHook {
  readonly type = 'file';

  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: ResourceGrantService,
  ) {}

  async purgeOwnerDeleted(userId: string, context: PurgeContext, limit: number): Promise<PurgeResult> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const targets = await tx.file.findMany({
        where: { owner_id: userId, deleted_at: null },
        select: { id: true },
        take: limit,
      });
      for (const t of targets) {
        await tx.file.update({
          where: { id: t.id },
          data: { status: 'DELETED', deleted_at: new Date() },
        });
        // Grant 를 남기면 RI-4(고아 Grant)가 울린다 — 리소스와 같은 트랜잭션에서 정리
        await this.grants.cleanupForResource(tx, 'file', t.id, context);
      }
      const remaining = await tx.file.count({ where: { owner_id: userId, deleted_at: null } });
      return { purged: targets.length, remaining: remaining > 0 };
    });
  }
}
