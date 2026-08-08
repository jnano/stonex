import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { INVARIANTS } from './invariant.registry';
import { CheckStatus, GovernancePatrolService, PatrolResult } from './patrol.service';

export interface CheckStatusView {
  id: string;
  title: string;
  severity: string;
  /** 'unknown' = 아직 판정 기록이 없다. **'ok' 와 반드시 구분한다**(RT-20) */
  status: CheckStatus | 'unknown';
  violations: number;
  error?: string;
}

export interface PatrolStatusView {
  /** 최근 실행이 기대 주기 안에 있었는가 — false 면 순찰이 멎은 것이다 */
  healthy: boolean;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  /** 마지막 실행에서 '검사 실패'가 있었는가 — 정상과 반드시 구분해 표시한다(RT-20) */
  hasFailedChecks: boolean;
  checks: CheckStatusView[];
  remediated: number;
  escalated: string[];
  unknownResourceTypes: string[];
}

export interface ActionView {
  at: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  /** 회수 전 행의 **일부만** 내보낸다 (§10.2 직렬화 화이트리스트) */
  before: { subject?: string; resourceType?: string; resourceId?: string; effect?: string } | null;
}

/** 순찰이 이 시간 안에 한 번도 안 돌았으면 "멎었다"고 본다 (기본 주기 10분의 3배) */
const HEALTHY_WINDOW_MS = Number(process.env.PATROL_HEALTHY_WINDOW_MS ?? 30 * 60 * 1000);

interface PatrolLogRow {
  created_at: Date;
  detail: {
    after?: {
      durationMs?: number;
      remediated?: number;
      escalated?: string[];
      unknownResourceTypes?: string[];
      checks?: Array<{ id: string; status: CheckStatus; violations: number; error?: string }>;
    };
  };
}

/**
 * 거버넌스 상태·활동 조회 (작업지시서 WP-14-5-1, RT-20).
 *
 * **데이터는 전부 기존 감사 로그·거버넌스 테이블에서 파생한다** — UI 용 별도 기록 체계를
 * 만들면 같은 사실이 두 곳에 저장되어 언젠가 갈라진다(이중 기록 금지).
 *
 * 표시 원칙 하나가 특히 중요하다: **"검사 실패"와 "이상 없음"을 절대 같은 색으로 두지 않는다.**
 * 감시 장치가 꺼진 상태를 정상으로 오인하면 대시보드가 있는 것이 없는 것만 못하다.
 */
@Injectable()
export class GovernanceStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly patrol: GovernancePatrolService,
  ) {}

  async status(): Promise<PatrolStatusView> {
    const [row] = await this.prisma.$queryRaw<PatrolLogRow[]>`
      SELECT created_at, detail FROM audit.audit_logs
       WHERE action = 'governance.patrol'
       ORDER BY created_at DESC LIMIT 1`;

    const after = row?.detail?.after;
    const recorded = new Map((after?.checks ?? []).map((c) => [c.id, c]));

    // 정의된 불변식 전체를 나열한다 — 기록에 없는 것은 'unknown' 이다.
    // 목록에서 빠뜨리면 "검사되지 않는 불변식"이 화면에서 사라져 아무도 모른다.
    const checks: CheckStatusView[] = INVARIANTS.map((def) => {
      const found = recorded.get(def.id);
      return {
        id: def.id,
        title: def.title,
        severity: def.severity,
        status: found?.status ?? 'unknown',
        violations: found?.violations ?? 0,
        error: found?.error,
      };
    });

    const lastRunAt = row?.created_at ?? null;
    return {
      healthy: lastRunAt !== null && Date.now() - lastRunAt.getTime() <= HEALTHY_WINDOW_MS,
      lastRunAt: lastRunAt?.toISOString() ?? null,
      lastDurationMs: after?.durationMs ?? null,
      hasFailedChecks: checks.some((c) => c.status === 'failed'),
      checks,
      remediated: after?.remediated ?? 0,
      escalated: after?.escalated ?? [],
      unknownResourceTypes: after?.unknownResourceTypes ?? [],
    };
  }

  /**
   * L-1 자동 조치 이력 — 시스템 행위(actor_id IS NULL)의 회수 기록.
   * 감사 `detail` 원문을 그대로 내보내지 않고 화이트리스트로 추린다(§10.2).
   */
  async actions(limit = 50): Promise<ActionView[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      created_at: Date;
      action: string;
      target_type: string | null;
      target_id: string | null;
      detail: { before?: Record<string, unknown>; reason?: string };
    }>>(
      `SELECT created_at, action, target_type, target_id, detail
         FROM audit.audit_logs
        WHERE actor_id IS NULL
          AND action IN ('grant.revoke', 'grant.cleanup', 'governance.patrol')
        ORDER BY created_at DESC
        LIMIT $1`,
      Math.min(Math.max(limit, 1), 200),
    );
    return rows.map((r) => ({
      at: r.created_at.toISOString(),
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.detail?.reason ?? null,
      before: r.detail?.before
        ? {
            subject: r.detail.before.subject as string | undefined,
            resourceType: r.detail.before.resourceType as string | undefined,
            resourceId: r.detail.before.resourceId as string | undefined,
            effect: r.detail.before.effect as string | undefined,
          }
        : null,
    }));
  }

  /** 마지막 순찰의 메모리 상태 (프로세스가 방금 뜬 경우 null) */
  inMemoryLast(): PatrolResult | null {
    return this.patrol.last;
  }
}
