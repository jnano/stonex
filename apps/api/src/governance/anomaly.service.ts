import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_TENANT_ID } from '../../../../db/seeds/permissions';
import { GOVERNANCE_NOTIFIER, GovernanceNotifier } from './notifier';
import { GovernanceFreezeService } from './freeze.service';

/** 업무 시간 (이 밖의 시간대에 일어나는 대량 권한 변경을 이상으로 본다) */
const BUSINESS_HOUR_START = Number(process.env.ANOMALY_BUSINESS_START ?? 9);
const BUSINESS_HOUR_END = Number(process.env.ANOMALY_BUSINESS_END ?? 19);
const OFFHOURS_ROLE_GRANTS = Number(process.env.ANOMALY_OFFHOURS_ROLE_GRANTS ?? 5);
const DENY_SPIKE = Number(process.env.ANOMALY_DENY_SPIKE ?? 10);
const BULK_GRANTS = Number(process.env.ANOMALY_BULK_GRANTS ?? 30);
/** 이 기간 동안 권한 행위가 없던 계정을 '휴면'으로 본다 */
const DORMANT_DAYS = Number(process.env.ANOMALY_DORMANT_DAYS ?? 90);

export interface AnomalySignal {
  ruleId: string;
  tenantId: string;
  actorId: string;
  title: string;
  detail: Record<string, unknown>;
}

interface RawSignal {
  tenant_id: string;
  actor_id: string;
  n: bigint;
}

/**
 * 규칙 기반 이상 탐지 (기획서 §14.3, 작업지시서 WP-14-4).
 *
 * 불변식(RI)이 **"있어서는 안 되는 상태"**를 보는 반면, 여기서는 **"정상일 수도 있지만
 * 설명이 필요한 행동"**을 본다. 그래서 자동 회수 같은 되돌릴 수 없는 조치는 하지 않고,
 * L-2 동결 후보로 올려 사람의 판단을 요구한다.
 *
 * 판정 근거는 전부 감사 로그다 — 별도 기록 체계를 만들지 않는다(이중 기록 금지).
 */
@Injectable()
export class AnomalyDetectionService {
  private readonly logger = new Logger(AnomalyDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly freeze: GovernanceFreezeService,
    @Inject(GOVERNANCE_NOTIFIER) private readonly notifier: GovernanceNotifier,
  ) {}

  /** 매시 05분. 순찰(10분)보다 성기게 도는 이유는 규칙이 시간 창을 보기 때문이다 */
  @Cron('5 * * * *')
  async scheduled(): Promise<void> {
    try {
      await this.detect();
    } catch (error) {
      this.logger.error('이상 탐지 실행 실패', error);
      await this.notifier.send({
        level: 'PAGE', title: '이상 탐지 실행 실패', body: (error as Error).message,
      });
    }
  }

  async detect(windowHours = 24): Promise<AnomalySignal[]> {
    const signals: AnomalySignal[] = [];
    signals.push(...(await this.offHoursRoleGrants(windowHours)));
    signals.push(...(await this.denySpike(windowHours)));
    signals.push(...(await this.bulkGrantCreation(windowHours)));
    signals.push(...(await this.dormantAdminAwakening(windowHours)));

    for (const signal of signals) {
      // 탐지는 **동결 후보**를 올릴 뿐 자동으로 묶지 않는다 — 오탐 한 번의 비용이
      // 서비스 중단이면 아무도 자동 대응을 켜지 않게 된다.
      await this.notifier.send({
        level: 'L2',
        title: `${signal.ruleId} — ${signal.title}`,
        body: `대상 ${signal.actorId}. 확인 후 필요하면 동결하십시오.`,
        detail: signal.detail,
      });
    }
    if (signals.length > 0) this.logger.warn(`이상 신호 ${signals.length}건`);
    return signals;
  }

  /** 비업무 시간대의 대량 역할 부여 */
  private async offHoursRoleGrants(windowHours: number): Promise<AnomalySignal[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawSignal[]>(
      `SELECT tenant_id, actor_id, count(*) AS n
         FROM audit.audit_logs
        WHERE action IN ('role.grant', 'role.revoke')
          AND actor_id IS NOT NULL
          AND created_at > now() - ($1 || ' hours')::interval
          AND (extract(hour FROM created_at) < $2 OR extract(hour FROM created_at) >= $3)
        GROUP BY tenant_id, actor_id
       HAVING count(*) >= $4`,
      String(windowHours), BUSINESS_HOUR_START, BUSINESS_HOUR_END, OFFHOURS_ROLE_GRANTS,
    );
    return rows.map((r) => ({
      ruleId: 'AN-1',
      tenantId: r.tenant_id,
      actorId: r.actor_id,
      title: '비업무 시간대 대량 역할 변경',
      detail: { count: Number(r.n), windowHours },
    }));
  }

  /**
   * 단일 계정의 거부 급증 — **권한 탐색(probing) 정황**이다.
   * 정상 사용자는 자기가 못 하는 일을 반복해서 시도하지 않는다.
   */
  private async denySpike(windowHours: number): Promise<AnomalySignal[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawSignal[]>(
      `SELECT tenant_id, actor_id, count(*) AS n
         FROM audit.audit_logs
        WHERE action = 'access.denied'
          AND actor_id IS NOT NULL
          AND created_at > now() - ($1 || ' hours')::interval
        GROUP BY tenant_id, actor_id
       HAVING count(*) >= $2`,
      String(windowHours), DENY_SPIKE,
    );
    return rows.map((r) => ({
      ruleId: 'AN-2',
      tenantId: r.tenant_id,
      actorId: r.actor_id,
      title: '거부 응답 급증 (권한 탐색 정황)',
      detail: { count: Number(r.n), windowHours },
    }));
  }

  /** 단시간 대량 Grant 생성 */
  private async bulkGrantCreation(windowHours: number): Promise<AnomalySignal[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawSignal[]>(
      `SELECT tenant_id, actor_id, count(*) AS n
         FROM audit.audit_logs
        WHERE action = 'grant.create'
          AND actor_id IS NOT NULL
          AND created_at > now() - ($1 || ' hours')::interval
        GROUP BY tenant_id, actor_id
       HAVING count(*) >= $2`,
      String(windowHours), BULK_GRANTS,
    );
    return rows.map((r) => ({
      ruleId: 'AN-3',
      tenantId: r.tenant_id,
      actorId: r.actor_id,
      title: '단시간 대량 Grant 생성',
      detail: { count: Number(r.n), windowHours },
    }));
  }

  /**
   * 휴면 관리 권한의 최초 사용 — 오래 쓰이지 않던 관리자 계정이 갑자기 권한을 옮기기 시작하는 것은
   * 계정 탈취의 전형적인 신호다.
   */
  private async dormantAdminAwakening(windowHours: number): Promise<AnomalySignal[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawSignal[]>(
      `WITH recent AS (
         SELECT tenant_id, actor_id, count(*) AS n, min(created_at) AS first_seen
           FROM audit.audit_logs
          WHERE action IN ('role.grant', 'role.revoke', 'role.permissions.set', 'grant.create')
            AND actor_id IS NOT NULL
            AND created_at > now() - ($1 || ' hours')::interval
          GROUP BY tenant_id, actor_id
       )
       SELECT r.tenant_id, r.actor_id, r.n
         FROM recent r
        WHERE NOT EXISTS (
          SELECT 1 FROM audit.audit_logs old
           WHERE old.actor_id = r.actor_id
             AND old.action IN ('role.grant', 'role.revoke', 'role.permissions.set', 'grant.create')
             AND old.created_at < r.first_seen
             AND old.created_at > r.first_seen - ($2 || ' days')::interval
        )`,
      String(windowHours), String(DORMANT_DAYS),
    );
    return rows.map((r) => ({
      ruleId: 'AN-4',
      tenantId: r.tenant_id,
      actorId: r.actor_id,
      title: `휴면(${DORMANT_DAYS}일) 관리 권한의 최초 사용`,
      detail: { count: Number(r.n), dormantDays: DORMANT_DAYS },
    }));
  }

  /**
   * 신호를 동결로 승격한다 (사람이 확인한 뒤 호출하는 경로).
   * 자동 동결하지 않는 이유는 위 `detect()` 주석과 같다.
   */
  async escalateToFreeze(signal: AnomalySignal, actorId: string | null): Promise<void> {
    await this.freeze.freeze({
      tenantId: signal.tenantId || DEFAULT_TENANT_ID,
      userId: signal.actorId,
      trigger: signal.ruleId,
      reason: signal.title,
      actorId,
    });
  }
}
