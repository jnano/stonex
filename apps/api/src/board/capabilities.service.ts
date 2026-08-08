import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardEventBus } from './event-bus';

/** 기능모듈 카탈로그 (스펙 §6.4 — WP-B5 에서 접근개입 4종·신고·조회수 편입) */
export const CAPABILITY_KEYS = [
  'attachment', 'reaction', 'tag', 'notification', 'view-count',
  'report', 'secret-post', 'co-author', 'user-block', 'mention',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * 게시판 기능모듈 on/off (WP-B3, 스펙 §6).
 *
 * 게시판별 `board_capabilities` 행이 없으면 **기본 활성**이다 — 프리셋(§5, WP-B5)이
 * 타입별 기본값을 채우기 전까지의 규칙. 기능모듈은 게시판 코어를 수정하지 않고
 * 얹힌다(BINV-2) — 코어는 여기 enabled 판정과 이벤트 버스만 안다.
 */
@Injectable()
export class BoardCapabilitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(boardId: string, key: CapabilityKey): Promise<boolean> {
    const row = await this.prisma.boardCapability.findUnique({
      where: { board_id_capability_key: { board_id: boardId, capability_key: key } },
    });
    return row ? row.enabled : true; // 미설정 = 기본 활성
  }

  async assertEnabled(boardId: string, key: CapabilityKey): Promise<void> {
    if (!(await this.isEnabled(boardId, key))) {
      // 꺼진 기능은 존재하지 않는 것처럼 — 게시판 설정을 외부에 알려주지 않는다
      throw new NotFoundException();
    }
  }
}

export interface ReactionSummary {
  kind: string;
  count: number;
  mine: boolean;
}

/**
 * 반응 기능모듈 (§6.4) — 게시판 코어 수정 없이 얹힌다(BINV-2).
 * 토글 멱등: 같은 (글·사람·종류)는 PK 가 중복을 막고, 재요청은 해제로 동작한다.
 */
@Injectable()
export class BoardReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly capabilities: BoardCapabilitiesService,
    private readonly bus: BoardEventBus,
  ) {}

  async toggle(
    subject: SubjectSnapshot,
    post: { id: string; board_id: string; owner_id: string },
    kind: string,
  ): Promise<{ added: boolean }> {
    await this.capabilities.assertEnabled(post.board_id, 'reaction');
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const key = { post_id: post.id, user_id: subject.id, kind };
      const existing = await tx.boardReaction.findUnique({ where: { post_id_user_id_kind: key } });
      if (existing) {
        await tx.boardReaction.delete({ where: { post_id_user_id_kind: key } });
        return { added: false };
      }
      await tx.boardReaction.create({ data: key });
      // 부수효과(알림)는 비동기 레인 — 본 트랜잭션과 함께 커밋된다(§6.2)
      await this.bus.publish(tx, {
        tenantId: subject.tenantId,
        topic: 'reaction.added',
        payload: { postId: post.id, boardId: post.board_id, actorId: subject.id, kind },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'board.reaction.add',
        targetType: 'post', targetId: post.id, detail: { before: {}, after: { kind } },
      });
      return { added: true };
    });
  }

  async summary(postId: string, viewerId: string): Promise<ReactionSummary[]> {
    const rows = await this.prisma.boardReaction.findMany({ where: { post_id: postId } });
    const byKind = new Map<string, { count: number; mine: boolean }>();
    for (const r of rows) {
      const entry = byKind.get(r.kind) ?? { count: 0, mine: false };
      entry.count += 1;
      if (r.user_id === viewerId) entry.mine = true;
      byKind.set(r.kind, entry);
    }
    return [...byKind.entries()].map(([kind, v]) => ({ kind, ...v }));
  }
}

/**
 * 댓글 반응 (WP-B6) — 글 반응과 **별도 표**를 쓴다(기존 board_reactions 무변경).
 * 같은 `reaction` 기능모듈 토글을 따르며, 토글 멱등도 동일하다.
 */
@Injectable()
export class CommentReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: BoardCapabilitiesService,
  ) {}

  async toggle(
    subject: SubjectSnapshot,
    comment: { id: string; post_id: string },
    boardId: string,
    kind: string,
  ): Promise<{ added: boolean }> {
    await this.capabilities.assertEnabled(boardId, 'reaction');
    const key = { comment_id: comment.id, user_id: subject.id, kind };
    const existing = await this.prisma.commentReaction.findUnique({
      where: { comment_id_user_id_kind: key },
    });
    if (existing) {
      await this.prisma.commentReaction.delete({ where: { comment_id_user_id_kind: key } });
      return { added: false };
    }
    await this.prisma.commentReaction.create({ data: key });
    return { added: true };
  }

  /** 게시글의 전체 댓글 반응을 한 번에 — 댓글 목록의 N+1 을 막는다 */
  async summaryForPost(
    postId: string,
    viewerId: string,
  ): Promise<Map<string, ReactionSummary[]>> {
    const rows = await this.prisma.commentReaction.findMany({
      where: { comment: { post_id: postId } },
    });
    const byComment = new Map<string, Map<string, { count: number; mine: boolean }>>();
    for (const r of rows) {
      const kinds = byComment.get(r.comment_id) ?? new Map();
      const entry = kinds.get(r.kind) ?? { count: 0, mine: false };
      entry.count += 1;
      if (r.user_id === viewerId) entry.mine = true;
      kinds.set(r.kind, entry);
      byComment.set(r.comment_id, kinds);
    }
    return new Map(
      [...byComment.entries()].map(([commentId, kinds]) => [
        commentId,
        [...kinds.entries()].map(([kind, v]) => ({ kind, ...v })),
      ]),
    );
  }
}

/** 태그 기능모듈 (§6.4) — 글 작성·수정 시 함께 저장, 목록·상세에 표시 */
@Injectable()
export class BoardTagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: BoardCapabilitiesService,
  ) {}

  /** 글 트랜잭션 안에서 태그 교체 — 기능이 꺼진 게시판이면 조용히 무시하지 않고 404 */
  async replaceForPost(
    tx: Prisma.TransactionClient,
    boardId: string,
    postId: string,
    tags: string[],
  ): Promise<void> {
    await this.capabilities.assertEnabled(boardId, 'tag');
    const unique = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))].slice(0, 10);
    await tx.boardTag.deleteMany({ where: { post_id: postId } });
    if (unique.length > 0) {
      await tx.boardTag.createMany({ data: unique.map((tag) => ({ post_id: postId, tag })) });
    }
  }

  async listForPost(postId: string): Promise<string[]> {
    const rows = await this.prisma.boardTag.findMany({ where: { post_id: postId }, orderBy: { tag: 'asc' } });
    return rows.map((r) => r.tag);
  }
}
