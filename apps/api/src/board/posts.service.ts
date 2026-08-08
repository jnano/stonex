import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Post } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardsService } from './boards.service';
import { AttachmentResult, BoardAttachmentService } from './board-attachment.service';
import { renderBodyHtml } from './render';

export interface PostSummary {
  id: string;
  boardId: string;
  ownerId: string;
  title: string;
  isPinned: boolean;
  commentCount: number;
  status: string;
  createdAt: string;
}

export interface PostDetail extends PostSummary {
  bodyHtml: string; // 표시는 언제나 렌더 캐시 — body_md 는 수정 화면에서만
  bodyMd: string;
  updatedAt: string;
  attachments: AttachmentResult[];
}

const toSummary = (p: Post): PostSummary => ({
  id: p.id, boardId: p.board_id, ownerId: p.owner_id, title: p.title,
  isPinned: p.is_pinned, commentCount: Number(p.comment_count), status: p.status,
  createdAt: p.created_at.toISOString(),
});

const toDetail = (p: Post, attachments: AttachmentResult[] = []): PostDetail => ({
  ...toSummary(p), bodyHtml: p.body_html, bodyMd: p.body_md, updatedAt: p.updated_at.toISOString(),
  attachments,
});

/**
 * 게시글 (WP-B1 — 스펙 §4·§10).
 *
 * 모든 접근은 2단 게이트다: 평면 1(can — Guard 가 이미 통과시킴) + 평면 2(canAccessBoard —
 * 여기서 BoardsService.loadAccessible 로 판정). 소유(owned) 판정은 평가기가 리소스 로드로
 * 이미 했으므로 서비스는 관계 규칙만 본다.
 */
@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly boards: BoardsService,
    private readonly attachments: BoardAttachmentService,
  ) {}

  /** 게시판 내 목록 — 고정글 우선, 최신순 (키셋 페이징 전환은 WP-B4) */
  async list(
    subject: SubjectSnapshot,
    boardId: string,
    page = 1,
    size = 20,
  ): Promise<{ items: PostSummary[]; total: number }> {
    await this.boards.loadAccessible(subject, boardId); // 평면 2 — 비가시 게시판은 여기서 404
    const take = Math.min(Math.max(size, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;

    const where: Prisma.PostWhereInput = {
      board_id: boardId,
      deleted_at: null,
      // 목록은 PUBLISHED 만 — DRAFT 는 작성자 본인에게만(§4), HIDDEN 은 운영 숨김
      OR: [{ status: 'PUBLISHED' }, { status: 'DRAFT', owner_id: subject.id }],
      // 탈퇴자 글은 퍼지 전이라도 즉시 제외(DEC-3 — file·domain 목록과 동일 규율)
      // 관계 미선언(OQ-2)이라 owner join 대신 표식 서브셋으로 거른다
      owner_id: { notIn: await this.deletedOwnerIds(boardId) },
    };
    const [rows, total] = await Promise.all([
      this.prisma.post.findMany({
        where,
        orderBy: [{ is_pinned: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
        skip, take,
      }),
      this.prisma.post.count({ where }),
    ]);
    return { items: rows.map(toSummary), total };
  }

  /** 이 게시판에서 글을 가진 탈퇴자 id — 소량(게시판 단위)이라 notIn 으로 충분하다 */
  private async deletedOwnerIds(boardId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ owner_id: string }>>`
      SELECT DISTINCT p.owner_id FROM posts p
        JOIN users u ON u.id = p.owner_id
       WHERE p.board_id = ${boardId}::uuid AND u.deleted_at IS NOT NULL`;
    return rows.map((r) => r.owner_id);
  }

  async detail(subject: SubjectSnapshot, postId: string): Promise<PostDetail> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at) throw new NotFoundException();
    // DRAFT 는 작성자 본인만, HIDDEN 은 상세도 은닉(운영 확인은 /admin 경로)
    if (post.status === 'DRAFT' && post.owner_id !== subject.id) throw new NotFoundException();
    if (post.status === 'HIDDEN' || post.status === 'DELETED') throw new NotFoundException();
    await this.boards.loadAccessible(subject, post.board_id); // 평면 2
    return toDetail(post, await this.attachments.listForPost(post.id));
  }

  async create(
    subject: SubjectSnapshot,
    boardId: string,
    input: { title: string; bodyMd: string; draft?: boolean; attachmentFileIds?: string[] },
  ): Promise<PostDetail> {
    await this.boards.loadAccessible(subject, boardId, { write: true }); // ARCHIVED 는 쓰기 불가
    const post = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.post.create({
        data: {
          tenant_id: subject.tenantId,
          board_id: boardId,
          owner_id: subject.id,
          title: input.title,
          body_md: input.bodyMd,
          body_html: renderBodyHtml(input.bodyMd),
          status: input.draft ? 'DRAFT' : 'PUBLISHED',
        },
      });
      // 첨부 링크 — 본인 소유분 한정 검증 포함(R-B7), 글과 같은 트랜잭션
      await this.attachments.linkToPost(tx, subject, created.id, input.attachmentFileIds ?? []);
      // 카운터는 같은 트랜잭션에서 증감(§4.1) — DRAFT 는 목록에 없으므로 세지 않는다
      if (!input.draft) {
        await tx.board.update({ where: { id: boardId }, data: { post_count: { increment: 1 } } });
      }
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'post.create',
        targetType: 'post', targetId: created.id,
        detail: { before: {}, after: { boardId, title: created.title, status: created.status } },
      });
      return created;
    });
    return toDetail(post, await this.attachments.listForPost(post.id));
  }

  /** 수정 — owned 판정은 Guard(평가기)가 리소스 로드로 이미 통과시켰다 */
  async update(
    subject: SubjectSnapshot,
    postId: string,
    input: { title?: string; bodyMd?: string; publish?: boolean; attachmentFileIds?: string[] },
  ): Promise<PostDetail> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at) throw new NotFoundException();

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const publishing = input.publish === true && post.status === 'DRAFT';
      const next = await tx.post.update({
        where: { id: postId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.bodyMd !== undefined
            ? { body_md: input.bodyMd, body_html: renderBodyHtml(input.bodyMd) }
            : {}),
          ...(publishing ? { status: 'PUBLISHED' } : {}),
        },
      });
      if (publishing) {
        await tx.board.update({ where: { id: post.board_id }, data: { post_count: { increment: 1 } } });
      }
      if (input.attachmentFileIds !== undefined) {
        await this.attachments.linkToPost(tx, subject, postId, input.attachmentFileIds);
      }
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'post.update',
        targetType: 'post', targetId: postId,
        detail: { before: { title: post.title, status: post.status }, after: { title: next.title, status: next.status } },
      });
      return next;
    });
    return toDetail(updated, await this.attachments.listForPost(postId));
  }

  async softDelete(subject: SubjectSnapshot, postId: string, viaAdmin = false): Promise<void> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at) throw new NotFoundException();

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.post.update({
        where: { id: postId },
        data: { status: 'DELETED', deleted_at: new Date() },
      });
      if (post.status === 'PUBLISHED') {
        await tx.board.update({ where: { id: post.board_id }, data: { post_count: { decrement: 1 } } });
      }
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id,
        action: viaAdmin ? 'post.delete.admin' : 'post.delete',
        targetType: 'post', targetId: postId,
        detail: { before: { status: post.status, ownerId: post.owner_id }, after: { status: 'DELETED' } },
      });
    });
  }

  /** 관리자 삭제 전 존재 확인 — .all 경로는 리소스형 게이트가 아니라서 서비스가 로드한다 */
  async loadForAdmin(subject: SubjectSnapshot, postId: string): Promise<Post> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at || post.tenant_id !== subject.tenantId) throw new NotFoundException();
    return post;
  }

}
