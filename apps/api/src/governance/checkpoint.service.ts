import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 감사 로그 일 단위 해시 체크포인트 (RI-7의 원본 생성).
 *
 * 하루가 끝난 뒤 그날 행 전체의 해시를 남긴다. 이후 누군가 과거 로그를 지우거나 고치면
 * RI-7 검사가 재계산 결과와 어긋나 위반으로 드러난다.
 *
 * **체인 구조**: 각 체크포인트는 직전 체크포인트의 chain_hash 를 물고 들어간다. 하루치 해시만
 * 저장하면 공격자가 그날 행을 지운 뒤 그날 해시만 다시 계산해 덮을 수 있다.
 * 해시 계산식은 DB 함수(`audit.day_digest`·`audit.chain_digest`)에 있으며 검증 SQL 과 공유한다(§15.1).
 */
@Injectable()
export class AuditCheckpointService {
  private readonly logger = new Logger(AuditCheckpointService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 매일 00:20 — 전날 마감분을 봉인한다 */
  @Cron('20 0 * * *')
  async daily(): Promise<void> {
    try {
      await this.checkpoint();
    } catch (error) {
      // 체크포인트가 멈추면 RI-7 의 검출 범위가 그 시점에서 얼어붙는다 — 조용히 넘기지 않는다
      this.logger.error('감사 체크포인트 생성 실패 — RI-7 검출 범위가 갱신되지 않습니다', error);
      throw error;
    }
  }

  /**
   * 지정일(기본: 어제) 체크포인트 생성. 이미 있으면 아무것도 하지 않는다(멱등).
   * @returns 생성했으면 true
   */
  async checkpoint(day?: Date): Promise<boolean> {
    const target = day ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const date = target.toISOString().slice(0, 10);

    const rows = await this.prisma.$queryRawUnsafe<Array<{ inserted: number }>>(
      `
      WITH prev AS (
        SELECT chain_hash FROM audit.audit_checkpoints
         WHERE period_date < $1::date ORDER BY period_date DESC LIMIT 1
      ),
      calc AS (
        SELECT $1::date AS period_date,
               (SELECT count(*) FROM audit.audit_logs
                 WHERE created_at >= $1::date AND created_at < $1::date + 1) AS row_count,
               (SELECT chain_hash FROM prev) AS prev_hash,
               audit.day_digest($1::date) AS day_hash
      )
      INSERT INTO audit.audit_checkpoints (period_date, row_count, prev_hash, day_hash, chain_hash)
      SELECT c.period_date, c.row_count, c.prev_hash, c.day_hash,
             audit.chain_digest(c.prev_hash::char(64), c.day_hash::char(64))
        FROM calc c
       WHERE NOT EXISTS (
         SELECT 1 FROM audit.audit_checkpoints e WHERE e.period_date = c.period_date
       )
      RETURNING 1 AS inserted`,
      date,
    );
    const created = rows.length > 0;
    if (created) this.logger.log(`감사 체크포인트 생성: ${date}`);
    return created;
  }
}
