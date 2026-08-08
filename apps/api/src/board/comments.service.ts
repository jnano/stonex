import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Comment } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardsService } from './boards.service';
import { BoardEventBus } from './event-bus';
import { PostPolicyService } from './post-policy.service';
import { validateSettings } from './presets';
import { BoardCapabilitiesService, CommentReactionsService } from './capabilities.service';
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
    private readonly capabilities: BoardCapabilitiesService,
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
      // 멘션은 기능모듈이다 — 꺼진 게시판에서는 이벤트를 만들지 않는다
      const mentioned = (await this.capabilities.isEnabled(post.board_id, 'mention'))
        ? await extractMentions(tx, subject.tenantId, input.bodyMd)
        : [];
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

  /**
   * 화면에 남는 자식 수 — **tombstone 도 자식으로 센다.**
   *
   * 목록 필터(§list)가 tombstone 을 보여주므로, 살아 있는 자식만 세면 "자식이
   * tombstone 뿐인 부모"를 완전 삭제해 자식이 부모 없이 떠 버린다. 화면에 보이는
   * 것과 같은 기준으로 세야 트리가 깨지지 않는다.
   */
  private async visibleChildCount(tx: Prisma.TransactionClient, parentId: string): Promise<number> {
    return tx.comment.count({
      where: {
        parent_id: parentId,
        OR: [{ deleted_at: null }, { status: 'DELETED', body_html: COMMENT_TOMBSTONE }],
      },
    });
  }

  /**
   * 역할을 다한 tombstone 정리 (조상 방향).
   *
   * tombstone 은 **자식을 붙들어 두기 위해서만** 존재한다 — 마지막 자식이 사라지면
   * 남을 이유가 없다. 부모가 tombstone 이고 보이는 자식이 0이 되면 완전 삭제하고,
   * 그 부모의 부모도 같은 조건이면 계속 올라간다(연쇄 정리).
   *
   * comment_count 는 tombstone 을 만들 때 이미 감소시켰으므로 여기서 또 빼지 않는다
   * (BRI-2 의 재계산 기준도 deleted_at IS NULL 이라 정합이 유지된다).
   */
  private async purgeOrphanTombstones(
    tx: Prisma.TransactionClient,
    startParentId: string | null,
  ): Promise<string[]> {
    const purged: string[] = [];
    let cursor = startParentId;
    let guard = 0;
    while (cursor && guard < 100) {
      const parent: Comment | null = await tx.comment.findUnique({ where: { id: cursor } });
      // tombstone 이 아니면(살아 있거나 이미 완전 삭제) 멈춘다
      if (!parent || parent.body_html !== COMMENT_TOMBSTONE || parent.deleted_at === null) break;
      if ((await this.visibleChildCount(tx, parent.id)) > 0) break;
      // 목록 필터에 걸리지 않게 tombstone 표식을 지운다 — 행은 남기되 보이지 않는다
      await tx.comment.update({ where: { id: parent.id }, data: { body_html: '', body_md: '' } });
      purged.push(parent.id);
      cursor = parent.parent_id;
      guard += 1;
    }
    return purged;
  }

  async softDelete(subject: SubjectSnapshot, commentId: string, viaAdmin = false): Promise<void> {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deleted_at) throw new NotFoundException();

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const children = await this.visibleChildCount(tx, commentId);
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
      // 이 댓글이 사라지면서 부모 tombstone 이 붙들 자식을 잃었을 수 있다 — 위로 정리
      const purged = children > 0 ? [] : await this.purgeOrphanTombstones(tx, comment.parent_id);
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id,
        action: viaAdmin ? 'comment.delete.admin' : 'comment.delete',
        targetType: 'comment', targetId: commentId,
        detail: {
          before: { ownerId: comment.owner_id },
          after: { tombstone: children > 0, purgedTombstones: purged.length },
        },
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
