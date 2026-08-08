import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardEvent, BoardEventConsumer } from './event-bus';
import { BoardPolicyService } from './board-policy.service';
import { PostPolicyService } from './post-policy.service';

export interface NotificationView {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

/** 이벤트 하나가 만들 수 있는 알림 수 상한 — 팬아웃이 쓰기 부하로 전이되는 것을 차단(R-B14) */
const FANOUT_LIMIT = 100;

/**
 * 알림 — 기반 기능모듈 (WP-B3, 스펙 §6.4, 검토 RT-32).
 *
 * mention(B5)·답글·reaction 이 각자 알림을 구현하지 않고 **outbox 레인으로 발행**하면
 * 여기가 소비한다(이중 구현 금지 §14.5). 알림 내용은 **링크·최소 메타만** 담는다 —
 * 열람 시점에 접근을 재판정하므로(§6.5), 비공개 게시판·비밀글 내용이 알림으로 새지 않는다.
 *
 * 멱등(at-least-once 대응): (user_id, source_event_id) 유니크 — 같은 이벤트가 재전달돼도
 * 알림은 한 번만 생긴다.
 */
@Injectable()
export class BoardNotificationService implements BoardEventConsumer {
  readonly topics = ['comment.created', 'reaction.added', 'mention.created'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly boardPolicy: BoardPolicyService,
    private readonly postPolicy: PostPolicyService,
  ) {}

  async consume(event: BoardEvent): Promise<void> {
    const recipients = await this.recipientsFor(event);
    for (const userId of recipients.slice(0, FANOUT_LIMIT)) {
      await this.prisma.boardNotification
        .create({
          data: {
            tenant_id: event.tenantId,
            user_id: userId,
            kind: event.topic,
            // 링크·최소 메타만 — 본문은 싣지 않는다(열람 시 재판정)
            payload: {
              boardId: event.payload.boardId ?? null,
              postId: event.payload.postId ?? null,
            },
            source_event_id: event.id,
          },
        })
        .catch((error: { code?: string }) => {
          if (error.code === 'P2002') return; // 멱등 — 이미 전달됨(재시도 중복)
          throw error;
        });
    }
  }

  private async recipientsFor(event: BoardEvent): Promise<string[]> {
    const postId = event.payload.postId as string | undefined;
    const actorId = event.payload.actorId as string | undefined;
    if (!postId) return [];
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at) return [];
    const board = await this.prisma.board.findUnique({ where: { id: post.board_id } });
    if (!board || board.deleted_at) return [];

    const candidates =
      event.topic === 'mention.created'
        ? ((event.payload.mentionedUserIds as string[] | undefined) ?? [])
        : post.owner_id === actorId
          ? []
          : [post.owner_id];

    // §6.5 mention: **수신자마다 접근을 재판정**한다 — 접근 불가한 게시판·비밀글의 존재가
    // 알림으로 새면 안 된다(R-B11). 글 작성자 알림도 같은 필터를 태워 경로를 하나로 유지한다.
    const allowed: string[] = [];
    for (const userId of [...new Set(candidates)].filter((id) => id !== actorId)) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.deleted_at) continue;
      const subject = {
        id: userId, tenantId: event.tenantId, status: 'ACTIVE', roles: [], pv: 1,
        permissions: new Map(),
      } as unknown as SubjectSnapshot;
      if (!(await this.boardPolicy.canAccessBoard(subject, board))) continue;
      if (!(await this.postPolicy.canReadPost(subject, post))) continue;
      allowed.push(userId);
    }
    return allowed;
  }

  // ── 조회 API (본인 한정) ──────────────────────────────────────

  async listMine(subject: SubjectSnapshot, unreadOnly = false): Promise<NotificationView[]> {
    const rows = await this.prisma.boardNotification.findMany({
      where: { user_id: subject.id, ...(unreadOnly ? { read_at: null } : {}) },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return rows.map((n) => ({
      id: n.id, kind: n.kind, payload: n.payload as Record<string, unknown>,
      createdAt: n.created_at.toISOString(), readAt: n.read_at?.toISOString() ?? null,
    }));
  }

  async markRead(subject: SubjectSnapshot, notificationId: string): Promise<void> {
    // 본인 것만 — 타인 알림 id 를 지목하는 경로 차단. 시간은 DB 시계(어댑터 시간대 결함 회피)
    const count = await this.prisma.$executeRaw`
      UPDATE board_notifications SET read_at = now()
       WHERE id = ${notificationId}::uuid AND user_id = ${subject.id}::uuid AND read_at IS NULL`;
    if (count === 0) throw new NotFoundException();
  }
}
