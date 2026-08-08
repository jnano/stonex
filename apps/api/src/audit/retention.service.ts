import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GOVERNANCE_NOTIFIER, GovernanceNotifier } from '../governance/notifier';

/**
 * 보존 기간 (WT-21).
 *
 * 디스크가 차면 감사 INSERT 가 실패하고 **INV-6 에 의해 모든 권한 변경이 롤백**된다 —
 * 즉 용량 관리는 저장소 문제가 아니라 가용성 문제다.
 */
const DEFAULT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS ?? 365 * 3);
/** 파티션 수가 이 값을 넘으면 경고 — 아카이브 배치가 멎었다는 신호다 */
const PARTITION_WARN_COUNT = Number(process.env.AUDIT_PARTITION_WARN ?? 40);

export interface RetentionReport {
  detachedPartitions: string[];
  partitionCount: number;
  totalBytes: number;
}

/**
 * 감사 로그 보존·아카이브 (기획서 §10.3, 작업지시서 WP-15-1).
 *
 * **애플리케이션은 감사 로그 행을 지우지 않는다**(§10.3 append-only). `stonex_app` 역할에는
 * DELETE 권한 자체가 없고, 코드에 삭제문을 두면 G-2 룰이 막는다. 조회 접근 로그(`access.read`)의
 * 단기 보존은 **관리자 자격으로 도는 `scripts/audit-retention.ts`** 가 맡는다 —
 * 감사 로그를 지울 수 있는 코드가 앱 안에 있으면 append-only 는 규약일 뿐 보증이 아니다.
 *
 * 보존 경과 파티션은 **`DETACH` 후 남긴다** — 곧바로 `DROP` 하지 않는 이유는, 잘못된 보존
 * 설정 하나로 법적 보관 의무가 있는 기록이 사라지는 것을 막기 위해서다. 분리된 테이블은
 * 조회 경로에서 빠져 성능에 영향을 주지 않으며, 실제 폐기는 운영자의 별도 판단으로 한다.
 */
@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(GOVERNANCE_NOTIFIER) private readonly notifier: GovernanceNotifier,
  ) {}

  @Cron('30 4 * * *')
  async daily(): Promise<void> {
    try {
      const report = await this.enforce();
      if (report.partitionCount > PARTITION_WARN_COUNT) {
        await this.notifier.send({
          level: 'L2',
          title: `감사 파티션 ${report.partitionCount}개 — 아카이브가 밀렸습니다`,
          body: '디스크가 차면 감사 INSERT 실패로 모든 권한 변경이 롤백됩니다(INV-6).',
          detail: { totalBytes: report.totalBytes },
        });
      }
    } catch (error) {
      this.logger.error('감사 보존 배치 실패', error);
      throw error;
    }
  }

  async enforce(): Promise<RetentionReport> {
    const detachedPartitions = await this.detachExpiredPartitions();
    const { count, bytes } = await this.partitionStats();
    return { detachedPartitions, partitionCount: count, totalBytes: bytes };
  }

  /** 보존 기간이 지난 월 파티션을 분리한다(삭제하지 않는다) */
  private async detachExpiredPartitions(): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ detached: string }>>(
      `DO $$
       DECLARE part RECORD; cutoff DATE := (now() - ($1 || ' days')::interval)::date;
       BEGIN
         FOR part IN
           SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'audit' AND c.relname ~ '^audit_logs_[0-9]{6}$'
         LOOP
           IF to_date(right(part.relname, 6), 'YYYYMM') < date_trunc('month', cutoff) THEN
             EXECUTE format('ALTER TABLE audit.audit_logs DETACH PARTITION audit.%I', part.relname);
             RAISE NOTICE '분리: %', part.relname;
           END IF;
         END LOOP;
       END $$;
       SELECT ''::text AS detached WHERE false`,
      String(DEFAULT_RETENTION_DAYS),
    ).catch((error) => {
      this.logger.warn(`파티션 분리 건너뜀: ${(error as Error).message}`);
      return [] as Array<{ detached: string }>;
    });
    return rows.map((r) => r.detached).filter(Boolean);
  }

  /** 파티션 수·총 용량 — 알림 임계 판정과 용량 산정 근거 */
  async partitionStats(): Promise<{ count: number; bytes: number }> {
    const [row] = await this.prisma.$queryRaw<Array<{ n: bigint; bytes: bigint }>>`
      SELECT count(*) AS n,
             coalesce(sum(pg_total_relation_size(c.oid)), 0) AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'audit' AND c.relkind = 'r'`;
    return { count: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
  }
}
