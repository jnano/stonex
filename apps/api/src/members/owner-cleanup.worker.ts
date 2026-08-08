import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerCleanupRegistry } from '../authorization/owner-cleanup';

/** 한 틱에 훅당 처리하는 리소스 상한 — 보유량에 비례하는 무제한 쓰기 방지(RT-27) */
const BATCH_LIMIT = 500;
/** 이 횟수를 소진하면 FAILED 로 굳힌다 — 순찰(cleanup-backlog 불변식)이 검출한다 */
const MAX_ATTEMPTS = 5;

interface ClaimedJob {
  id: string;
  tenant_id: string;
  user_id: string;
  attempts: number;
}

/**
 * 소유자 정리 퍼지 워커 (WP-K2).
 *
 * 회원 삭제 트랜잭션이 넣은 `owner_cleanup_jobs` 를 배치로 소화한다. 도메인 검증 워커와
 * 같은 잡 클레임 패턴(`FOR UPDATE SKIP LOCKED`)을 쓴다 — 새 워커 프레임을 만들지
 * 않는다(§14.5 이중 구현 금지, RT-38).
 *
 * 실패 격리(WP-K2 작업 6): 퍼지 실패는 회원 삭제를 되돌리지 않는다 — 삭제는 이미
 * 커밋됐고 은닉도 표식으로 이미 걸려 있다(DEC-3). 실패한 잡은 재시도 큐에 남고,
 * 소진되면 FAILED 로 굳어 순찰이 보고한다. 한 리소스 타입의 퍼지 버그가
 * 회원 삭제 기능 자체를 막지 않는다.
 */
@Injectable()
export class OwnerCleanupWorker {
  private readonly logger = new Logger(OwnerCleanupWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hooks: OwnerCleanupRegistry,
  ) {}

  @Interval(10_000)
  async tick(): Promise<void> {
    // 한 틱에 잡 하나 — 여러 인스턴스가 떠도 SKIP LOCKED 로 중복 처리되지 않는다
    const job = await this.claim();
    if (!job) return;
    await this.run(job);
  }

  private async claim(): Promise<ClaimedJob | null> {
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE owner_cleanup_jobs
         SET status = 'RUNNING', updated_at = now()
       WHERE id = (
         SELECT id FROM owner_cleanup_jobs
          WHERE status = 'PENDING'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, tenant_id, user_id, attempts`;
    return rows[0] ?? null;
  }

  /** 예외를 밖으로 던지지 않는다 — 던지면 잡이 RUNNING 으로 굳는다(검증 워커와 동일 규율) */
  private async run(job: ClaimedJob): Promise<void> {
    try {
      let anyRemaining = false;
      for (const hook of this.hooks.all()) {
        // 잡 생성 시점의 관리자를 여기서 알 수 없다 — 퍼지는 시스템 행위로 감사된다
        const result = await hook.purgeOwnerDeleted(
          job.user_id,
          { tenantId: job.tenant_id, actorId: null },
          BATCH_LIMIT,
        );
        if (result.purged > 0) {
          this.logger.log(`소유자 정리: ${hook.type} ${result.purged}건 (user ${job.user_id})`);
        }
        anyRemaining = anyRemaining || result.remaining;
      }
      // 남은 것이 있으면 PENDING 으로 되돌려 다음 틱에 계속한다 — 한 틱의 작업량이
      // 훅 수 × BATCH_LIMIT 을 넘지 않게 하는 것이 목적이므로 attempts 는 올리지 않는다
      // 시간 갱신은 DB 시계(now())로 한다 — 클라이언트 Date 는 시간대가 어긋난다(schema 주석)
      await this.prisma.$executeRaw`
        UPDATE owner_cleanup_jobs SET status = ${anyRemaining ? 'PENDING' : 'DONE'}, updated_at = now()
         WHERE id = ${job.id}::uuid`;
    } catch (error) {
      const attempts = job.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      this.logger.error(
        `소유자 정리 실패 (user ${job.user_id}, ${attempts}/${MAX_ATTEMPTS}): ${(error as Error).message}`,
      );
      await this.prisma.$executeRaw`
        UPDATE owner_cleanup_jobs
           SET status = ${failed ? 'FAILED' : 'PENDING'}, attempts = ${attempts},
               last_error = ${(error as Error).message.slice(0, 500)}, updated_at = now()
         WHERE id = ${job.id}::uuid`
        .catch(() => undefined); // 상태 갱신마저 실패하면 RUNNING 으로 남고, 순찰이 잡는다
    }
  }
}
