import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Comment } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardsService } from './boards.service';
import { BoardEventBus } from './event-bus';
import { PostPolicyService } from './post-policy.service';
import { validateSettings } from './presets';
import { CommentReactionsService } from './capabilities.service';
import { COMMENT_TOMBSTONE, extractMentions, renderBodyHtml } from './render';

export interface CommentReactionView {
  kind: string;
  count: number;
  mine: boolean;
}

export interface CommentView {
  id: string;
  postId: string;
  ownerId: string;
  /** 작성자 표시명 — 이메일은 싣지 않는다(§10.2) */
  ownerName: string;
  parentId: string | null;
  depth: number;
  bodyHtml: string;
  /** 수정 화면용 원본 — 본인 댓글에만 실린다(남의 원본을 줄 이유가 없다) */
  bodyMd?: string;
  status: string;
  createdAt: string;
  reactions: CommentReactionView[];
}

const toView = (
  c: Comment,
  extra: { ownerName?: string; reactions?: CommentReactionView[]; viewerId?: string } = {},
): CommentView => ({
  id: c.id, postId: c.post_id, ownerId: c.owner_id, ownerName: extra.ownerName ?? '',
  parentId: c.parent_id, depth: c.depth, bodyHtml: c.body_html,
  // 본인 댓글만 원본을 준다 — 수정 화면이 필요로 하는 최소 노출
  bodyMd: extra.viewerId === c.owner_id ? c.body_md : undefined,
  status: c.status, createdAt: c.created_at.toISOString(),
  reactions: extra.reactions ?? [],
});

/** path 세그먼트 폭 — '0001.0007.0003' (§9.1). 4자리 = 형제 9,999개 상한 */
const SEG = 4;

/**
 * 댓글 (WP-B1 기본 CRUD — materialized path 저장, 트리 표시·깊이 제한·동시성 보강은 WP-B3).
 *
 * 접근은 게시글과 같은 2단 게이트: can(board.comment 등) + canAccessBoard.
 * 삭제는 자식 유무로 갈린다(§4.1) — 자식 있으면 tombstone 로 트리 보존, 없으면 소프트 삭제.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly boards: BoardsService,
    private readonly bus: BoardEventBus,
    private readonly policy: PostPolicyService,
    private readonly reactions: CommentReactionsService,
  ) {}

  /** 게시글의 댓글 전체 — path 사전순 = 트리 전위순회(§9). 페이징은 WP-B3 */
  async list(subject: SubjectSnapshot, postId: string): Promise<CommentView[]> {
    const post = await this.loadPost(subject, postId);
    const rows = await this.prisma.comment.findMany({
      where: {
        post_id: post.id,
        // 삭제됐어도 자식이 있으면 tombstone 으로 남는다(트리 보존). 자식 없는 삭제는
        // body_html 이 대체되지 않았으므로 이 조건에 걸리지 않아 목록에서 빠진다
        OR: [{ deleted_at: null }, { status: 'DELETED', body_html: COMMENT_TOMBSTONE }],
        owner_id: { notIn: await this.deletedOwnerIds(post.id) },
      },
      orderBy: { path: 'asc' },
    });
    // 이름·반응을 한 번에 모아 붙인다 — 댓글마다 조회하면 N+1 이 된다
    const [names, reactionsByComment] = await Promise.all([
      this.ownerNames(rows.map((r) => r.owner_id)),
      this.reactions.summaryForPost(post.id, subject.id),
    ]);
    return rows.map((c) =>
      toView(c, {
        ownerName: names.get(c.owner_id) ?? '(알 수 없음)',
        reactions: reactionsByComment.get(c.id) ?? [],
        viewerId: subject.id,
      }),
    );
  }

  /** 작성자 표시명 일괄 조회 (N+1 방지) */
  private async ownerNames(ownerIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ownerIds)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } }, select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** 댓글 반응 토글 — 게시판의 reaction 기능이 꺼져 있으면 404 */
  async toggleReaction(subject: SubjectSnapshot, commentId: string, kind: string): Promise<{ added: boolean }> {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deleted_at) throw new NotFoundException();
    const post = await this.loadPost(subject, comment.post_id); // 2단 게이트 재사용
    return this.reactions.toggle(subject, comment, post.board_id, kind);
  }

  private async deletedOwnerIds(postId: string): Promise<string[]> {
    // 탈퇴자 댓글은 퍼지 전이라도 즉시 제외(DEC-3). tombstone 만 남은 행은 이미 무해하다
    const rows = await this.prisma.$queryRaw<Array<{ owner_id: string }>>`
      SELECT DISTINCT c.owner_id FROM comments c
        JOIN users u ON u.id = c.owner_id
       WHERE c.post_id = ${postId}::uuid AND u.deleted_at IS NOT NULL AND c.deleted_at IS NULL`;
    return rows.map((r) => r.owner_id);
  }

  async create(
    subject: SubjectSnapshot,
    postId: string,
    input: { bodyMd: string; parentId?: string },
  ): Promise<CommentView> {
    const post = await this.loadPost(subject, postId, { write: true });

    const comment = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let parentPath = '';
      let depth = 0;
      if (input.parentId) {
        const parent = await tx.comment.findUnique({ where: { id: input.parentId } });
        if (!parent || parent.post_id !== post.id || parent.status !== 'PUBLISHED') {
          throw new BadRequestException('대댓글 대상 댓글이 유효하지 않습니다.');
        }
        parentPath = parent.path + '.';
        depth = parent.depth + 1;
      }
      // 형제 시퀀스 동시성(§9.3): **부모 단위 advisory lock** — 같은 부모에 동시 작성만
      // 직렬화되고, 다른 부모·다른 스레드는 병행한다. 게시글 행 FOR UPDATE(B1 잠정판)는
      // 글 전체 댓글을 직렬화해 인기 글에서 병목이었다. xact lock 이라 커밋 시 자동 해제.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${(input.parentId ?? post.id) + ':siblings'}))`;
      const last = await tx.comment.findFirst({
        where: { post_id: post.id, parent_id: input.parentId ?? null },
        orderBy: { path: 'desc' },
        select: { path: true },
      });
      const lastSeq = last ? parseInt(last.path.split('.').pop() ?? '0', 10) : 0;
      const path = parentPath + String(lastSeq + 1).padStart(SEG, '0');

      const created = await tx.comment.create({
        data: {
          tenant_id: subject.tenantId,
          post_id: post.id,
          owner_id: subject.id,
          parent_id: input.parentId ?? null,
          path, depth,
          body_md: input.bodyMd,
          body_html: renderBodyHtml(input.bodyMd),
        },
      });
      await tx.post.update({ where: { id: post.id }, data: { comment_count: { increment: 1 } } });
      // 부수효과(작성자 알림)는 비동기 레인 — 본 트랜잭션과 함께 커밋(§6.2)
      const mentioned = await extractMentions(tx, subject.tenantId, input.bodyMd);
      await this.bus.publish(tx, {
        tenantId: subject.tenantId,
        topic: 'comment.created',
        payload: {
          postId: post.id, boardId: post.board_id, actorId: subject.id, commentId: created.id,
          mentionedUserIds: mentioned,
        },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'comment.create',
        targetType: 'comment', targetId: created.id,
        detail: { before: {}, after: { postId: post.id, parentId: input.parentId ?? null } },
      });
      return created;
    });
    const names = await this.ownerNames([comment.owner_id]);
    return toView(comment, { ownerName: names.get(comment.owner_id) ?? '', viewerId: subject.id });
  }

  async update(subject: SubjectSnapshot, commentId: string, bodyMd: string): Promise<CommentView> {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deleted_at) throw new NotFoundException();

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const next = await tx.comment.update({
        where: { id: commentId },
        data: { body_md: bodyMd, body_html: renderBodyHtml(bodyMd) },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'comment.update',
        targetType: 'comment', targetId: commentId,
        detail: { before: {}, after: {} }, // 본문은 감사에 싣지 않는다 — 개인 발화 내용
      });
      return next;
    });
    const names = await this.ownerNames([updated.owner_id]);
    return toView(updated, { ownerName: names.get(updated.owner_id) ?? '', viewerId: subject.id });
  }

  async softDelete(subject: SubjectSnapshot, commentId: string, viaAdmin = false): Promise<void> {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deleted_at) throw new NotFoundException();

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const children = await tx.comment.count({
        where: { parent_id: commentId, deleted_at: null },
      });
      // 자식이 있으면 트리 구조 보존을 위해 tombstone(§4.1, BINV-4) — 본문만 지운다
      await tx.comment.update({
        where: { id: commentId },
        data: {
          status: 'DELETED',
          deleted_at: new Date(),
          ...(children > 0 ? { body_md: '', body_html: COMMENT_TOMBSTONE } : {}),
        },
      });
      await tx.post.updateMany({
        where: { id: comment.post_id },
        data: { comment_count: { decrement: 1 } },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id,
        action: viaAdmin ? 'comment.delete.admin' : 'comment.delete',
        targetType: 'comment', targetId: commentId,
        detail: { before: { ownerId: comment.owner_id }, after: { tombstone: children > 0 } },
      });
    });
  }

  async loadForAdmin(subject: SubjectSnapshot, commentId: string): Promise<Comment> {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deleted_at || comment.tenant_id !== subject.tenantId) throw new NotFoundException();
    return comment;
  }

  /** 게시글 로드 + 2단 게이트(게시글 가시성 → 게시판 정책) */
  private async loadPost(
    subject: SubjectSnapshot,
    postId: string,
    options: { write?: boolean } = {},
  ): Promise<{ id: string; board_id: string; tenant_id: string }> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at || post.status !== 'PUBLISHED') throw new NotFoundException();
    const board = await this.boards.loadAccessible(subject, post.board_id, options);
    // 비밀글의 댓글은 글과 같은 판정(R-B11 — 목록·검색·알림·댓글 전 경로 결합)
    if (!(await this.policy.canReadPost(subject, post))) throw new NotFoundException();
    // 댓글 기능이 꺼진 게시판(FAQ 프리셋)은 작성 거부 — 설정은 정책의 입력(BINV-1)
    if (options.write && !validateSettings(board.settings).comment.enabled) {
      throw new NotFoundException();
    }
    return post;
  }
}
