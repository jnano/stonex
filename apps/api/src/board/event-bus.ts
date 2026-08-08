import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 게시판 이벤트 버스 (WP-B3, 스펙 §6.2).
 *
 * 두 레인:
 *  - **동기 레인**: 도메인 트랜잭션 안에서 직접 하는 일(카운터 증감 등) — 별도 장치 없음
 *  - **비동기 레인(여기)**: 부수효과(알림·집계). 도메인 트랜잭션이 outbox 행을 함께
 *    커밋하고, 워커가 꺼내 소비자에게 전달한다 — **at-least-once**. 트랜잭션 밖에서
 *    직접 발송하면 커밋 실패 시 유령 알림이, 커밋 후 발송 실패 시 유실이 생긴다.
 *
 * 중복 억제는 소비자 몫이다: 전달이 재시도되면 같은 이벤트가 두 번 올 수 있으므로,
 * 소비자는 event.id 기준으로 멱등해야 한다(notification 은 유니크 제약으로 구현).
 * 잡 클레임은 도메인 검증·퍼지 워커와 같은 패턴(FOR UPDATE SKIP LOCKED) — §14.5.
 */

export interface BoardEvent {
  id: string;
  tenantId: string;
  topic: string;
  payload: Record<string, unknown>;
}

export interface BoardEventConsumer {
  /** 구독 토픽 — 목록에 없는 토픽은 이 소비자에게 전달되지 않는다 */
  topics: string[];
  /** 멱등해야 한다(at-least-once). 던지면 이벤트가 재시도 큐에 남는다 */
  consume(event: BoardEvent): Promise<void>;
}

const MAX_ATTEMPTS = 5;
const BATCH = 20;

@Injectable()
export class BoardEventBus {
  private readonly logger = new Logger(BoardEventBus.name);
  private readonly consumers: BoardEventConsumer[] = [];

  constructor(private readonly prisma: PrismaService) {}

  register(consumer: BoardEventConsumer): void {
    this.consumers.push(consumer);
  }

  /** 도메인 트랜잭션 안에서 호출 — 이벤트는 본 작업과 함께 커밋되거나 함께 사라진다 */
  async publish(
    tx: Prisma.TransactionClient,
    event: { tenantId: string; topic: string; payload: Record<string, unknown> },
  ): Promise<void> {
    await tx.boardOutboxEvent.create({
      data: { tenant_id: event.tenantId, topic: event.topic, payload: event.payload as Prisma.InputJsonValue },
    });
  }

  @Interval(5_000)
  async tick(): Promise<void> {
    // 한 틱에 한 배치 — 여러 인스턴스가 떠도 SKIP LOCKED 로 중복 클레임되지 않는다
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; tenant_id: string; topic: string; payload: unknown; attempts: number }>
    >`
      UPDATE board_outbox_events
         SET processed_at = now()
       WHERE id IN (
         SELECT id FROM board_outbox_events
          WHERE processed_at IS NULL
          ORDER BY created_at
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, tenant_id, topic, payload, attempts`;

    for (const row of rows) {
      const event: BoardEvent = {
        id: row.id, tenantId: row.tenant_id, topic: row.topic,
        payload: row.payload as Record<string, unknown>,
      };
      try {
        for (const consumer of this.consumers) {
          if (consumer.topics.includes(event.topic)) await consumer.consume(event);
        }
      } catch (error) {
        const attempts = row.attempts + 1;
        this.logger.error(`이벤트 소비 실패 (${event.topic}, ${attempts}/${MAX_ATTEMPTS}): ${(error as Error).message}`);
        // 재시도: processed_at 을 되돌린다. 소진되면 processed 로 두되 오류를 남긴다 —
        // 무한 재시도는 뒤 이벤트 전체를 막는다(head-of-line blocking)
        await this.prisma.$executeRaw`
          UPDATE board_outbox_events
             SET processed_at = ${attempts >= MAX_ATTEMPTS ? Prisma.sql`now()` : Prisma.sql`NULL`},
                 attempts = ${attempts},
                 last_error = ${(error as Error).message.slice(0, 500)}
           WHERE id = ${row.id}::uuid`.catch(() => undefined);
      }
    }
  }
}
