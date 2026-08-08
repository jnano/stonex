import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Comment } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardsService } from './boards.service';
import { BoardEventBus } from './event-bus';
import { COMMENT_TOMBSTONE, renderBodyHtml } from './render';

export interface CommentView {
  id: string;
  postId: string;
  ownerId: string;
  parentId: string | null;
  depth: number;
  bodyHtml: string;
  status: string;
  createdAt: string;
}

const toView = (c: Comment): CommentView => ({
  id: c.id, postId: c.post_id, ownerId: c.owner_id, parentId: c.parent_id,
  depth: c.depth, bodyHtml: c.body_html, status: c.status, createdAt: c.created_at.toISOString(),
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
    return rows.map(toView);
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
      await this.bus.publish(tx, {
        tenantId: subject.tenantId,
        topic: 'comment.created',
        payload: { postId: post.id, boardId: post.board_id, actorId: subject.id, commentId: created.id },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'comment.create',
        targetType: 'comment', targetId: created.id,
        detail: { before: {}, after: { postId: post.id, parentId: input.parentId ?? null } },
      });
      return created;
    });
    return toView(comment);
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
    return toView(updated);
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
  ): Promise<{ id: string; board_id: string }> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at || post.status !== 'PUBLISHED') throw new NotFoundException();
    await this.boards.loadAccessible(subject, post.board_id, options);
    return post;
  }
}
