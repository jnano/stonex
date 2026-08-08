import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Post } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardsService } from './boards.service';
import { AttachmentResult, BoardAttachmentService } from './board-attachment.service';
import { BoardTagsService } from './capabilities.service';
import { ViewCountService } from './view-count.service';
import { PostPolicyService } from './post-policy.service';
import { BoardCapabilitiesService } from './capabilities.service';
import { BoardEventBus } from './event-bus';
import { validateSettings } from './presets';
import { extractMentions } from './render';
import { renderBodyHtml } from './render';

export interface PostSummary {
  id: string;
  boardId: string;
  ownerId: string;
  /** 작성자 표시명 — 이메일은 싣지 않는다(§10.2 최소 노출). 탈퇴자는 익명화 이름이 온다 */
  ownerName: string;
  title: string;
  isPinned: boolean;
  commentCount: number;
  viewCount: number;
  status: string;
  isSecret: boolean;
  createdAt: string;
  /** 채택된 답변 댓글 id — null 이면 미해결(§B9). QNA 가 아니어도 필드는 존재한다 */
  acceptedCommentId: string | null;
}

export interface PostDetail extends PostSummary {
  bodyHtml: string; // 표시는 언제나 렌더 캐시 — body_md 는 수정 화면에서만
  bodyMd: string;
  updatedAt: string;
  attachments: AttachmentResult[];
  tags: string[];
}

const toSummary = (p: Post, ownerName = ''): PostSummary => ({
  id: p.id, boardId: p.board_id, ownerId: p.owner_id, ownerName, title: p.title,
  isPinned: p.is_pinned, commentCount: Number(p.comment_count), viewCount: Number(p.view_count),
  status: p.status, isSecret: p.is_secret, createdAt: p.created_at.toISOString(),
  acceptedCommentId: p.accepted_comment_id,
});

const toDetail = (
  p: Post, attachments: AttachmentResult[] = [], tags: string[] = [], ownerName = '',
): PostDetail => ({
  ...toSummary(p, ownerName), bodyHtml: p.body_html, bodyMd: p.body_md,
  updatedAt: p.updated_at.toISOString(), attachments, tags,
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
    private readonly views: ViewCountService,
    private readonly policy: PostPolicyService,
    private readonly capabilities: BoardCapabilitiesService,
    private readonly bus: BoardEventBus,
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
    options: { cursor?: string; size?: number; unansweredOnly?: boolean } = {},
  ): Promise<{ items: PostSummary[]; nextCursor: string | null }> {
    const board = await this.boards.loadAccessible(subject, boardId); // 평면 2 — 비가시는 404
    // 페이지 크기 기본값은 **게시판 설정**이다(§5 paging.size) — 요청이 명시하면 그것을 쓴다
    const defaultSize = validateSettings(board.settings).paging.size;
    const take = Math.min(Math.max(options.size ?? defaultSize, 1), 100);
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
    // 비밀글 스코프(BINV-3 — canReadPost 의 쿼리 등가) + 차단 표시 필터(보안 경계 아님 §6.5)
    const secret = await this.policy.secretScope(subject);
    // 차단 표시 필터는 기능모듈이다 — 꺼진 게시판에서는 적용하지 않는다
    const blocked = (await this.capabilities.isEnabled(boardId, 'user-block'))
      ? await this.policy.blockedIds(subject.id)
      : [];
    const secretFilter: Prisma.PostWhereInput = secret.bypassAll
      ? {}
      : {
          OR: [
            { is_secret: false },
            { owner_id: subject.id },
            { id: { in: secret.readablePostIds } },
            { board_id: { in: secret.moderateBoardIds } },
          ],
        };
    const blockFilter: Prisma.PostWhereInput =
      blocked.length > 0 ? { NOT: { owner_id: { in: blocked } } } : {};

    const pinned = after
      ? []
      : await this.prisma.post.findMany({
          where: { ...base, ...blockFilter, AND: [secretFilter], is_pinned: true },
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
         AND (${secret.bypassAll}::boolean OR p.is_secret = false OR p.owner_id = ${subject.id}::uuid
              OR p.id = ANY(${secret.readablePostIds}::uuid[])
              OR p.board_id = ANY(${secret.moderateBoardIds}::uuid[]))
         AND NOT (p.owner_id = ANY(${blocked}::uuid[]))
         AND (NOT ${options.unansweredOnly === true}::boolean OR p.accepted_comment_id IS NULL)
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
    const all = [...pinned, ...pageRows];
    const names = await this.ownerNames(all.map((r) => r.owner_id));
    return {
      items: all.map((r) => toSummary(r, names.get(r.owner_id) ?? '(알 수 없음)')),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }


  /** 작성자 표시명 일괄 조회 — 목록의 N+1 을 막는다(id → name) */
  private async ownerNames(ownerIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ownerIds)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } }, select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
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
    // 비밀글(§6.5): 숨김은 노출에 우선 — 판정 실패는 403 이 아니라 404(존재 은닉)
    if (!(await this.policy.canReadPost(subject, post))) throw new NotFoundException();
    // 조회수는 기능모듈이다 — 꺼진 게시판에서는 세지 않는다(요청 경로 I/O 는 어차피 없다)
    if (await this.capabilities.isEnabled(post.board_id, 'view-count')) this.views.bump(post.id);
    const names = await this.ownerNames([post.owner_id]);
    return toDetail(
      post, await this.attachments.listForPost(post.id), await this.tags.listForPost(post.id),
      names.get(post.owner_id) ?? '(알 수 없음)',
    );
  }

  async create(
    subject: SubjectSnapshot,
    boardId: string,
    input: {
      title: string; bodyMd: string; draft?: boolean; attachmentFileIds?: string[]; tags?: string[];
      secret?: boolean; secretReaderIds?: string[];
    },
  ): Promise<PostDetail> {
    const board = await this.boards.loadAccessible(subject, boardId, { write: true }); // ARCHIVED 쓰기 불가
    // write_policy=MODERATOR(공지·FAQ 프리셋): 설정은 정책 판정의 입력이지 인가가 아니다(BINV-1) —
    // 최종 판정은 여기 정책 함수. 운영 권한 없는 작성은 404 로 은닉하지 않고 403 — 게시판은 이미 보인다
    const settings = validateSettings(board.settings);
    if (settings.write_policy === 'MODERATOR') {
      const canModerate =
        subject.permissions.has('board.moderate.all') ||
        (await this.policy.secretScope(subject)).moderateBoardIds.includes(boardId);
      if (!canModerate) throw new ForbiddenException('이 게시판은 운영자만 글을 쓸 수 있습니다.');
    }
    if (input.secret) await this.capabilities.assertEnabled(boardId, 'secret-post');
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
          is_secret: input.secret === true,
        },
      });
      if (input.secret && input.secretReaderIds?.length) {
        await tx.postSecretReader.createMany({
          data: [...new Set(input.secretReaderIds)].map((userId) => ({ post_id: created.id, user_id: userId })),
          skipDuplicates: true,
        });
      }
      // 멘션(§6.5): 대상 목록만 이벤트에 싣는다 — 수신 여부는 소비 시점에 접근 재판정
      const mentioned = (await this.capabilities.isEnabled(boardId, 'mention'))
        ? await extractMentions(tx, subject.tenantId, input.bodyMd)
        : [];
      if (!input.draft && mentioned.length > 0) {
        await this.bus.publish(tx, {
          tenantId: subject.tenantId, topic: 'mention.created',
          payload: { postId: created.id, boardId, actorId: subject.id, mentionedUserIds: mentioned },
        });
      }
      // 첨부 링크 — 본인 소유분 한정 검증 포함(R-B7), 상한은 게시판 설정을 따른다
      await this.attachments.linkToPost(
        tx, subject, created.id, input.attachmentFileIds ?? [], settings.editor.max_attachments,
      );
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
    const createdNames = await this.ownerNames([post.owner_id]);
    return toDetail(
      post, await this.attachments.listForPost(post.id), await this.tags.listForPost(post.id),
      createdNames.get(post.owner_id) ?? '',
    );
  }

  /**
   * 수정 — **인증 게이트형 + 정책 함수** (§6.5 co-author).
   * owned scope(단일 owner_id)로는 공동작성을 표현할 수 없어 라우트는 인증만 확인하고,
   * 여기서 canEditPost(작성자 ∨ 공동작성자 ∨ 운영자)가 판정한다. 거부는 404 은닉.
   */
  async update(
    subject: SubjectSnapshot,
    postId: string,
    input: { title?: string; bodyMd?: string; publish?: boolean; attachmentFileIds?: string[]; tags?: string[] },
  ): Promise<PostDetail> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at) throw new NotFoundException();
    if (post.status === 'HIDDEN' || post.status === 'DELETED') throw new NotFoundException();
    if (!(await this.policy.canEditPost(subject, post))) throw new NotFoundException();

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
    const updatedNames = await this.ownerNames([updated.owner_id]);
    return toDetail(
      updated, await this.attachments.listForPost(postId), await this.tags.listForPost(postId),
      updatedNames.get(updated.owner_id) ?? '',
    );
  }

  /** 공동작성자 지정 (§6.5) — **원작성자만** 바꿀 수 있다. owner_id 는 불변(R-B12) */
  async setCoAuthors(subject: SubjectSnapshot, postId: string, userIds: string[]): Promise<void> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at) throw new NotFoundException();
    await this.capabilities.assertEnabled(post.board_id, 'co-author');
    if (post.owner_id !== subject.id) throw new NotFoundException(); // 원작성자 한정 — 은닉
    const unique = [...new Set(userIds)].filter((id) => id !== post.owner_id).slice(0, 10);
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.postAuthor.deleteMany({ where: { post_id: postId } });
      if (unique.length > 0) {
        await tx.postAuthor.createMany({
          data: unique.map((userId) => ({ post_id: postId, user_id: userId })),
          skipDuplicates: true,
        });
      }
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'post.coauthors.set',
        targetType: 'post', targetId: postId,
        detail: { before: {}, after: { coAuthors: unique.length } },
      });
    });
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

  /**
   * 운영 행위 (스펙 §10.1 `moderate/*`) — 고정·이동·숨김/해제.
   *
   * 게이트는 컨트롤러의 `board.moderate`(게시판 Grant) 또는 `board.moderate.all`.
   * 셋 다 **소프트한 표시 변경**이다 — 삭제가 아니므로 되돌릴 수 있고, 전부 감사에 남는다.
   * 숨김(HIDDEN)은 신고 자동 발동(R-B15)과 같은 상태를 쓴다 — 운영자 수동/자동의
   * 차이는 감사 action 으로 구분하고 상태는 하나로 유지한다(상태가 둘이면 복구 경로가 갈린다).
   */
  async moderate(
    subject: SubjectSnapshot,
    postId: string,
    action: { pin?: boolean; hide?: boolean; moveToBoardId?: string },
  ): Promise<PostSummary> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at || post.tenant_id !== subject.tenantId) throw new NotFoundException();

    if (action.moveToBoardId) {
      // 이동 대상 게시판도 접근·쓰기 가능해야 한다 — 안 보이는 게시판으로 밀어 넣어
      // 글을 사실상 소각하는 경로를 막는다
      await this.boards.loadAccessible(subject, action.moveToBoardId, { write: true });
    }

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const next = await tx.post.update({
        where: { id: postId },
        data: {
          ...(action.pin !== undefined ? { is_pinned: action.pin } : {}),
          ...(action.hide !== undefined
            ? { status: action.hide ? 'HIDDEN' : 'PUBLISHED' }
            : {}),
          ...(action.moveToBoardId ? { board_id: action.moveToBoardId } : {}),
        },
      });
      // 카운터는 게시판 소속·공개 상태가 바뀔 때 함께 움직인다(§4.1)
      const wasCounted = post.status === 'PUBLISHED';
      const isCounted = next.status === 'PUBLISHED';
      if (action.moveToBoardId && action.moveToBoardId !== post.board_id) {
        if (wasCounted) {
          await tx.board.update({ where: { id: post.board_id }, data: { post_count: { decrement: 1 } } });
        }
        if (isCounted) {
          await tx.board.update({ where: { id: action.moveToBoardId }, data: { post_count: { increment: 1 } } });
        }
      } else if (wasCounted !== isCounted) {
        await tx.board.update({
          where: { id: post.board_id },
          data: { post_count: isCounted ? { increment: 1 } : { decrement: 1 } },
        });
      }
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'post.moderate',
        targetType: 'post', targetId: postId,
        detail: {
          before: { status: post.status, isPinned: post.is_pinned, boardId: post.board_id },
          after: { status: next.status, isPinned: next.is_pinned, boardId: next.board_id },
        },
      });
      return next;
    });
    const names = await this.ownerNames([updated.owner_id]);
    return toSummary(updated, names.get(updated.owner_id) ?? '');
  }

  /**
   * 답변 채택 (WP-B9, `accepted-answer` 기능모듈 — §5.2 QNA).
   *
   * **질문 작성자만** 채택한다 — 운영자도 대신 정하지 않는다(질문의 해결 여부는
   * 질문자가 판단할 일이다). 채택은 질문당 1개이며, 같은 댓글을 다시 채택하면 해제된다
   * (별도 "채택 취소" 라우트를 두는 대신 토글 — 재채택이 자연스럽다).
   *
   * 채택 사실은 답변자에게 알린다 — 발행은 outbox 비동기 레인(§6.2)이고, 수신 여부는
   * 소비 시점의 접근 재판정이 정한다(§6.5).
   */
  async acceptAnswer(
    subject: SubjectSnapshot,
    postId: string,
    commentId: string,
  ): Promise<PostDetail> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at) throw new NotFoundException();
    await this.capabilities.assertEnabled(post.board_id, 'accepted-answer');
    // 질문 작성자 한정 — 은닉(403 은 "채택 가능한 글이 있다"를 알려준다)
    if (post.owner_id !== subject.id) throw new NotFoundException();

    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deleted_at || comment.post_id !== postId) throw new NotFoundException();
    if (comment.owner_id === subject.id) {
      throw new ForbiddenException('자기 답변은 채택할 수 없습니다.');
    }

    const next = post.accepted_comment_id === commentId ? null : commentId;
    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.post.update({
        where: { id: postId },
        data: { accepted_comment_id: next },
      });
      if (next) {
        await this.bus.publish(tx, {
          tenantId: subject.tenantId,
          topic: 'answer.accepted',
          payload: {
            postId, boardId: post.board_id, actorId: subject.id,
            mentionedUserIds: [comment.owner_id], // 답변자에게만
          },
        });
      }
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id,
        action: next ? 'post.answer.accept' : 'post.answer.unaccept',
        targetType: 'post', targetId: postId,
        detail: { before: { accepted: post.accepted_comment_id }, after: { accepted: next } },
      });
      return row;
    });
    const names = await this.ownerNames([updated.owner_id]);
    return toDetail(
      updated, await this.attachments.listForPost(postId), await this.tags.listForPost(postId),
      names.get(updated.owner_id) ?? '',
    );
  }

  /** 운영자가 볼 수 있는 숨김 글 상세 — 일반 상세는 HIDDEN 을 404 로 가린다 */
  async detailForModerator(subject: SubjectSnapshot, postId: string): Promise<PostDetail> {
    const post = await this.loadForAdmin(subject, postId);
    const names = await this.ownerNames([post.owner_id]);
    return toDetail(
      post, await this.attachments.listForPost(post.id), await this.tags.listForPost(post.id),
      names.get(post.owner_id) ?? '',
    );
  }

  /** 관리자 삭제 전 존재 확인 — .all 경로는 리소스형 게이트가 아니라서 서비스가 로드한다 */
  async loadForAdmin(subject: SubjectSnapshot, postId: string): Promise<Post> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at || post.tenant_id !== subject.tenantId) throw new NotFoundException();
    return post;
  }

}
