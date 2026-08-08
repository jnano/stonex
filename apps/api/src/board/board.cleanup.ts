import { Injectable } from '@nestjs/common';
import { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerCleanupHook, PurgeContext, PurgeResult } from '../authorization/owner-cleanup';

/**
 * board 모듈 소유자 정리 훅 (WP-B1) — WP-K2 훅 계약의 첫 신규 사용자.
 *
 * 탈퇴 회원의 게시글·댓글을 소프트 삭제하고 멤버십을 정리한다. 게시판 자체는
 * 회원 소유가 아니므로(§3.3) 손대지 않는다 — 생성 관리자가 탈퇴해도 게시판은 남는다.
 * 은닉은 소유자 표식이 즉시 담당하므로(DEC-3), 여기서의 지연은 정합의 문제다.
 */
@Injectable()
export class BoardOwnerCleanupHook implements OwnerCleanupHook {
  readonly type = 'board';

  constructor(private readonly prisma: PrismaService) {}

  async purgeOwnerDeleted(userId: string, context: PurgeContext, limit: number): Promise<PurgeResult> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 멤버십·게시판 단위 Grant 는 소량(저카디널리티) — 첫 배치에서 한 번에 정리
      await tx.boardMember.deleteMany({ where: { user_id: userId } });

      const posts = await tx.post.findMany({
        where: { owner_id: userId, deleted_at: null },
        select: { id: true, board_id: true },
        take: limit,
      });
      for (const p of posts) {
        await tx.post.update({
          where: { id: p.id },
          data: { status: 'DELETED', deleted_at: new Date() },
        });
        // 카운터는 글 상태 변화와 같은 트랜잭션에서 증감(§4.1)
        await tx.board.update({
          where: { id: p.board_id },
          data: { post_count: { decrement: 1 } },
        });
      }

      const comments = await tx.comment.findMany({
        where: { owner_id: userId, deleted_at: null },
        select: { id: true, post_id: true },
        take: limit,
      });
      for (const c of comments) {
        await tx.comment.update({
          where: { id: c.id },
          data: { status: 'DELETED', deleted_at: new Date() },
        });
        await tx.post.updateMany({
          where: { id: c.post_id },
          data: { comment_count: { decrement: 1 } },
        });
      }

      const [remainingPosts, remainingComments] = await Promise.all([
        tx.post.count({ where: { owner_id: userId, deleted_at: null } }),
        tx.comment.count({ where: { owner_id: userId, deleted_at: null } }),
      ]);
      void context; // Grant 정리: board Grant 는 subject 기준 정리(§5.3 cleanupForSubject)가 이미 담당
      return {
        purged: posts.length + comments.length,
        remaining: remainingPosts > 0 || remainingComments > 0,
      };
    });
  }
}
