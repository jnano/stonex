import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 기간 필터의 최대 폭. 파티션 프루닝이 의미를 가지려면 창이 유한해야 한다 */
const MAX_RANGE_DAYS = Number(process.env.AUDIT_QUERY_MAX_DAYS ?? 92);
const MAX_PAGE_SIZE = 200;

/**
 * **timestamptz 는 UTC 텍스트로 투영하고, 파라미터는 ISO 문자열로 넘긴다.**
 *
 * `@prisma/adapter-pg` 의 raw 경로는 timestamptz 를 **세션 시간대의 벽시계로** 주고받는다.
 * DB 세션이 Asia/Seoul 이면 읽을 때 9시간 앞선 Date 가 되고, JS `Date` 를 파라미터로 넘기면
 * 같은 크기만큼 어긋나 **범위 필터가 조용히 0건을 반환한다**(실측 확인).
 * 지금까지 드러나지 않은 이유는 다른 코드가 전부 서버 측 `now() - interval` 로 비교했기 때문이다.
 */
const UTC_ISO = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface AuditQuery {
  from: Date;
  to: Date;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  page?: number;
  size?: number;
}

export interface AuditEntryView {
  id: string;
  at: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** 변경 전/후 요약. 원문을 그대로 내보내지 않는다(§10.2) */
  detail: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ADM-4 감사 로그 조회 (기획서 §6.5).
 *
 * `audit_logs` 는 월 파티션 테이블이라 **기간 필터가 필수**다. 없으면 전 구간을 훑어
 * 조회 하나가 DB 를 점유하고, 그 사이 감사 INSERT 가 밀리면 INV-6 규칙상
 * **모든 권한 변경이 롤백**된다 — 조회가 서비스 중단으로 번지는 경로다.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async search(tenantId: string, query: AuditQuery): Promise<{ items: AuditEntryView[]; total: number }> {
    const { from, to } = this.validateRange(query);
    for (const [name, value] of [['actorId', query.actorId], ['targetId', query.targetId]] as const) {
      if (value && !UUID_RE.test(value)) throw new BadRequestException(`${name} 형식이 올바르지 않습니다.`);
    }

    const take = Math.min(Math.max(query.size ?? 50, 1), MAX_PAGE_SIZE);
    const skip = (Math.max(query.page ?? 1, 1) - 1) * take;

    // 파라미터 바인딩으로만 조립한다 — 문자열 연결은 그 자체로 주입 경로다
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: bigint; at: string; actor_id: string | null; action: string;
      target_type: string | null; target_id: string | null; detail: Record<string, unknown>;
    }>>(
      `SELECT id, ${UTC_ISO('created_at')} AS at, actor_id, action, target_type, target_id, detail
         FROM audit.audit_logs
        WHERE tenant_id = $1::uuid
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          AND ($4::uuid IS NULL OR actor_id = $4::uuid)
          AND ($5::text IS NULL OR action = $5)
          AND ($6::text IS NULL OR target_type = $6)
          AND ($7::uuid IS NULL OR target_id = $7::uuid)
        ORDER BY created_at DESC, id DESC
        LIMIT $8 OFFSET $9`,
      tenantId, from.toISOString(), to.toISOString(), query.actorId ?? null, query.action ?? null,
      query.targetType ?? null, query.targetId ?? null, take, skip,
    );

    const [count] = await this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM audit.audit_logs
        WHERE tenant_id = $1::uuid
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          AND ($4::uuid IS NULL OR actor_id = $4::uuid)
          AND ($5::text IS NULL OR action = $5)
          AND ($6::text IS NULL OR target_type = $6)
          AND ($7::uuid IS NULL OR target_id = $7::uuid)`,
      tenantId, from.toISOString(), to.toISOString(), query.actorId ?? null, query.action ?? null,
      query.targetType ?? null, query.targetId ?? null,
    );

    return {
      items: rows.map((r) => ({
        id: String(r.id),
        at: r.at,
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        detail: r.detail ?? {},
      })),
      total: Number(count?.n ?? 0),
    };
  }

  /** 대표 쿼리의 실행 계획 — DoD "Seq Scan 부재" 확인용 */
  async explain(tenantId: string, query: AuditQuery): Promise<string> {
    const { from, to } = this.validateRange(query);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT id FROM audit.audit_logs
        WHERE tenant_id = $1::uuid
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          AND ($4::uuid IS NULL OR actor_id = $4::uuid)
          AND ($5::text IS NULL OR action = $5)
        ORDER BY created_at DESC LIMIT 50`,
      tenantId, from.toISOString(), to.toISOString(), query.actorId ?? null, query.action ?? null,
    );
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  }

  private validateRange(query: AuditQuery): { from: Date; to: Date } {
    const { from, to } = query;
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
      throw new BadRequestException('조회 시작 시각(from)이 필요합니다.');
    }
    if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('조회 종료 시각(to)이 필요합니다.');
    }
    if (to <= from) throw new BadRequestException('조회 종료 시각이 시작 시각보다 뒤여야 합니다.');
    const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(`조회 기간은 최대 ${MAX_RANGE_DAYS}일입니다.`);
    }
    return { from, to };
  }
}
