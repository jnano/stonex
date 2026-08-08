import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Post } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardsService } from './boards.service';
import { AttachmentResult, BoardAttachmentService } from './board-attachment.service';
import { BoardTagsService } from './capabilities.service';
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
  tags: string[];
}

const toSummary = (p: Post): PostSummary => ({
  id: p.id, boardId: p.board_id, ownerId: p.owner_id, title: p.title,
  isPinned: p.is_pinned, commentCount: Number(p.comment_count), status: p.status,
  createdAt: p.created_at.toISOString(),
});

const toDetail = (p: Post, attachments: AttachmentResult[] = [], tags: string[] = []): PostDetail => ({
  ...toSummary(p), bodyHtml: p.body_html, bodyMd: p.body_md, updatedAt: p.updated_at.toISOString(),
  attachments, tags,
});

/**
 * 키셋 커서 (§8.2) — **마지막 행의 id 만** 불투명 문자열로 담는다.
 *
 * (created_at, id) 값을 커서에 직접 실으면 JS Date 가 밀리초로 잘려(Postgres 는
 * 마이크로초) 같은 밀리초의 행이 다음 페이지에 중복 반환된다 — 실측으로 재현됐다.
 * 대신 id 만 담고, 행 비교는 DB 안에서 원본 정밀도로 한다(list 의 raw 서브쿼리).
 * 커서 행이 소프트 삭제돼도 행 자체는 남으므로 기준점은 유지된다.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeCursor = (id: string): string => Buffer.from(id).toString('base64url');
const decodeCursor = (cursor: string): string | null => {
  try {
    const id = Buffer.from(cursor, 'base64url').toString();
    return UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
};

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
    private readonly tags: BoardTagsService,
  ) {}

  /**
   * 게시판 내 목록 — **키셋 페이징** (§8.2, WP-B3).
   *
   * OFFSET 은 깊은 페이지일수록 앞 행 전체를 세며 선형으로 느려진다. (created_at, id)
   * 복합 커서는 부분 인덱스(idx_posts_board_created)를 그대로 타 깊이와 무관하게 일정하다.
   * 고정글은 **첫 페이지에만 병합**한다 — 커서 흐름에 끼우면 중복·누락이 생긴다.
   */
  async list(
    subject: SubjectSnapshot,
    boardId: string,
    options: { cursor?: string; size?: number } = {},
  ): Promise<{ items: PostSummary[]; nextCursor: string | null }> {
    await this.boards.loadAccessible(subject, boardId); // 평면 2 — 비가시 게시판은 여기서 404
    const take = Math.min(Math.max(options.size ?? 20, 1), 100);
    const after = options.cursor ? decodeCursor(options.cursor) : null;

    const base: Prisma.PostWhereInput = {
      board_id: boardId,
      deleted_at: null,
      // 목록은 PUBLISHED 만 — DRAFT 는 작성자 본인에게만(§4), HIDDEN 은 운영 숨김
      OR: [{ status: 'PUBLISHED' }, { status: 'DRAFT', owner_id: subject.id }],
      // 탈퇴자 글은 퍼지 전이라도 즉시 제외(DEC-3 — file·domain 목록과 동일 규율)
      NOT: { owner_id: { in: await this.deletedOwnerIdsFor(boardId) } },
    };

    // 첫 페이지: 고정글 전부 + 일반 첫 배치. 이후 페이지: 커서 이후 일반 글만
    const pinned = after
      ? []
      : await this.prisma.post.findMany({
          where: { ...base, is_pinned: true },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        });
    // 커서 이후 판정은 DB 의 (created_at, id) 행 비교 — 마이크로초 정밀도를 잃지 않는다
    const idRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM posts p
       WHERE p.board_id = ${boardId}::uuid
         AND p.deleted_at IS NULL
         AND p.is_pinned = false
         AND (p.status = 'PUBLISHED' OR (p.status = 'DRAFT' AND p.owner_id = ${subject.id}::uuid))
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.owner_id AND u.deleted_at IS NOT NULL)
         AND (${after}::uuid IS NULL OR (p.created_at, p.id) <
              (SELECT c.created_at, c.id FROM posts c WHERE c.id = ${after}::uuid))
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${take + 1}`;
    const hasMore = idRows.length > take;
    const pageIds = idRows.slice(0, take).map((r) => r.id);
    const loaded = await this.prisma.post.findMany({ where: { id: { in: pageIds } } });
    const byId = new Map(loaded.map((r) => [r.id, r]));
    const pageRows = pageIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    const last = pageIds[pageIds.length - 1];
    return {
      items: [...pinned.map(toSummary), ...pageRows.map(toSummary)],
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }


  /** 이 게시판에서 글을 가진 탈퇴자 id — 고정글 쿼리용(키셋 본문은 raw NOT EXISTS 로 거른다) */
  private async deletedOwnerIdsFor(boardId: string): Promise<string[]> {
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
    return toDetail(post, await this.attachments.listForPost(post.id), await this.tags.listForPost(post.id));
  }

  async create(
    subject: SubjectSnapshot,
    boardId: string,
    input: { title: string; bodyMd: string; draft?: boolean; attachmentFileIds?: string[]; tags?: string[] },
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
      if (input.tags !== undefined) await this.tags.replaceForPost(tx, boardId, created.id, input.tags);
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
    return toDetail(post, await this.attachments.listForPost(post.id), await this.tags.listForPost(post.id));
  }

  /** 수정 — owned 판정은 Guard(평가기)가 리소스 로드로 이미 통과시켰다 */
  async update(
    subject: SubjectSnapshot,
    postId: string,
    input: { title?: string; bodyMd?: string; publish?: boolean; attachmentFileIds?: string[]; tags?: string[] },
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
      if (input.tags !== undefined) await this.tags.replaceForPost(tx, post.board_id, postId, input.tags);
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'post.update',
        targetType: 'post', targetId: postId,
        detail: { before: { title: post.title, status: post.status }, after: { title: next.title, status: next.status } },
      });
      return next;
    });
    return toDetail(updated, await this.attachments.listForPost(postId), await this.tags.listForPost(postId));
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
