import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { PrismaGrantStore } from '../authorization/grant.store';
import { DEFAULT_TENANT_ID } from '../../../../db/seeds/permissions';
import { GOVERNANCE_NOTIFIER, GovernanceNotifier } from './notifier';
import {
  INVARIANTS,
  InvariantDef,
  Severity,
  Violation,
  assertContextUsable,
  buildContext,
  loadSql,
} from './invariant.registry';

/** 순찰 주기 — 기본 10분 (기획서 §14.3) */
const PATROL_CRON = process.env.PATROL_CRON ?? '*/10 * * * *';
/** 불변식 쿼리 1건의 상한. 순찰이 주기를 넘겨 누적되면 커넥션 풀을 고갈시킨다 */
const STATEMENT_TIMEOUT_MS = Number(process.env.PATROL_STATEMENT_TIMEOUT_MS ?? 5_000);
const TX_TIMEOUT_MS = Number(process.env.PATROL_TX_TIMEOUT_MS ?? 60_000);
/** blast-radius 상한 (WT-11) — 절대 건수와 전체 대비 비율 중 **먼저 걸리는 쪽**을 쓴다 */
const BLAST_RADIUS_ROWS = Number(process.env.PATROL_BLAST_RADIUS_ROWS ?? 20);
const BLAST_RADIUS_RATIO = Number(process.env.PATROL_BLAST_RADIUS_RATIO ?? 0.01);
/** advisory lock 키 — 이 숫자는 순찰 전용이며 다른 용도로 재사용하지 않는다 */
export const PATROL_LOCK_KEY = 8_140_001;

export type CheckStatus = 'ok' | 'violated' | 'failed' | 'unavailable';

export interface CheckResult {
  id: string;
  title: string;
  severity: Severity;
  status: CheckStatus;
  violations: Violation[];
  /** status='failed' 일 때의 사유 — 대시보드가 "이상 없음"과 구분해 표시한다(RT-20) */
  error?: string;
}

export interface PatrolResult {
  startedAt: string;
  durationMs: number;
  /** 다른 인스턴스가 이미 돌고 있어 건너뛴 주기 */
  skipped?: 'lock' | 'overlap';
  checks: CheckResult[];
  /** L-1 자동 회수 결과 */
  remediated: number;
  /** blast-radius 상한에 걸려 자동 조치를 중단하고 승격한 검사 ID */
  escalated: string[];
  /** 검사 대상이 아닌(미등록) 리소스 타입 — 위반이 아니라 "검사 불가"다 */
  unknownResourceTypes: string[];
}

interface RawViolation {
  ri_id: string;
  subject: string;
  detail: Record<string, unknown>;
}

/**
 * 런타임 불변식 순찰 (기획서 §14.3~14.4).
 *
 * CI 게이트가 "배포 전"을 지킨다면 이 워커는 "운영 중"을 지킨다. 불변식은 전부
 * `governance/invariants/*.sql` 에 선언적으로 두고(§15.2), 여기서는 **실행·판정·대응**만 한다.
 *
 * 세 가지 안전장치가 함께 걸려 있다.
 *  - **단일 실행**: `pg_try_advisory_xact_lock` — `@nestjs/schedule` 은 프로세스 내
 *    스케줄러라 N대 운영 시 N중 실행된다(WT-18). 잠금을 얻지 못한 주기는 건너뛴다.
 *  - **중첩 가드 + statement_timeout**: 순찰 1회가 주기를 넘겨 누적되면 순찰 자체가 장애 원인이 된다.
 *  - **blast-radius 상한**: 대량 위반은 데이터 이상이 아니라 **불변식 정의가 현실과 어긋났다**는
 *    신호다(WT-11). 임계치를 넘으면 자동 조치를 멈추고 승격한다.
 */
@Injectable()
export class GovernancePatrolService {
  private readonly logger = new Logger(GovernancePatrolService.name);
  private running = false;
  private lastResult: PatrolResult | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly grants: ResourceGrantService,
    private readonly grantStore: PrismaGrantStore,
    @Inject(GOVERNANCE_NOTIFIER) private readonly notifier: GovernanceNotifier,
  ) {}

  /** 마지막 순찰 결과 — 거버넌스 API 가 "가동 여부·최근 실행"에 쓴다 */
  get last(): PatrolResult | null {
    return this.lastResult;
  }

  @Cron(PATROL_CRON)
  async scheduled(): Promise<void> {
    try {
      await this.patrol();
    } catch (error) {
      // 순찰 실패를 삼키면 감시 장치가 꺼진 것을 아무도 모른다(DoD)
      this.logger.error('순찰 실행 실패', error);
      await this.notifier.send({
        level: 'PAGE',
        title: '불변식 순찰 실행 실패',
        body: (error as Error).message,
      });
    }
  }

  async patrol(): Promise<PatrolResult> {
    if (this.running) {
      const skipped = this.emptyResult('overlap');
      this.logger.warn('이전 순찰이 아직 실행 중이라 이번 주기를 건너뜁니다.');
      return skipped;
    }
    this.running = true;
    const startedAt = new Date();
    try {
      const context = buildContext();
      // **fail-open 차단**: 컨텍스트가 비면 RI-3·RI-4가 위반 0건을 반환한다.
      // 검사 불가 상태를 "이상 없음"으로 보고하지 않도록 여기서 끊는다.
      assertContextUsable(context);

      const result = await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => this.runLocked(tx, context, startedAt),
        { timeout: TX_TIMEOUT_MS, maxWait: 5_000 },
      );
      this.lastResult = result;
      return result;
    } finally {
      this.running = false;
    }
  }

  private async runLocked(
    tx: Prisma.TransactionClient,
    context: ReturnType<typeof buildContext>,
    startedAt: Date,
  ): Promise<PatrolResult> {
    const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${PATROL_LOCK_KEY}) AS locked`;
    if (!lock?.locked) {
      this.logger.log('다른 인스턴스가 순찰 중이라 이번 주기를 건너뜁니다.');
      return this.emptyResult('lock');
    }
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

    const payload = JSON.stringify(context);
    const checks: CheckResult[] = [];
    for (const def of INVARIANTS) {
      checks.push(await this.runOne(tx, def, payload));
    }

    const unknownResourceTypes = await this.findUnknownResourceTypes(tx, context.knownResourceTypes);
    const { remediated, escalated } = await this.respond(tx, checks, unknownResourceTypes);

    const result: PatrolResult = {
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      checks,
      remediated,
      escalated,
      unknownResourceTypes,
    };

    // **감시자도 감사 대상이다**(§14.4). 순찰 실행 자체를 남겨야 "언제부터 안 돌았는가"를
    // 사후에 물을 수 있고, 거버넌스 API 도 이 기록에서 상태를 파생한다(별도 기록 체계 금지).
    await this.audit.record(tx, {
      tenantId: DEFAULT_TENANT_ID,
      actorId: null, // 시스템 행위
      action: 'governance.patrol',
      targetType: 'governance',
      detail: {
        before: {},
        after: {
          durationMs: result.durationMs,
          remediated,
          escalated,
          unknownResourceTypes,
          checks: checks.map((c) => ({
            id: c.id, status: c.status, violations: c.violations.length, error: c.error,
          })),
        },
      },
    });
    return result;
  }

  /**
   * 불변식 1건 실행. **SAVEPOINT 로 감싼다** — 쿼리 오류가 나면 PostgreSQL 트랜잭션 전체가
   * abort 상태가 되어 뒤의 불변식이 전부 "검사 실패"로 무너진다. 한 건의 SQL 오류가
   * 순찰 전체를 마비시키지 않게 격리한다.
   */
  private async runOne(tx: Prisma.TransactionClient, def: InvariantDef, payload: string): Promise<CheckResult> {
    const base = { id: def.id, title: def.title, severity: def.severity };
    const savepoint = `ri_${def.id.replace('-', '_').toLowerCase()}`;
    // **저장점을 먼저 만든다.** SQL 로드가 먼저 실패하면 존재하지 않는 저장점으로 롤백하게 되고,
    // 그 롤백 실패가 트랜잭션 전체를 abort 시켜 **뒤의 불변식이 전부 무너진다**(실제로 재현됨).
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    try {
      const sql = loadSql(def);
      // 컨텍스트가 필요 없는 불변식(RI-1·2·5·7)도 있다. 파라미터를 무조건 넘기면
      // "bind message supplies 1 parameters, but prepared statement requires 0" 으로 죽는다.
      const rows = sql.includes('$1')
        ? await tx.$queryRawUnsafe<RawViolation[]>(sql, payload)
        : await tx.$queryRawUnsafe<RawViolation[]>(sql);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      return {
        ...base,
        status: rows.length === 0 ? 'ok' : 'violated',
        violations: rows.map((r) => ({ ri_id: r.ri_id, subject: r.subject, detail: r.detail })),
      };
    } catch (error) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
      // 실패를 'ok' 로 접으면 감시 장치가 꺼진 것을 대시보드가 "정상"으로 표시한다(RT-20)
      this.logger.error(`${def.id} 검사 실패: ${(error as Error).message}`);
      return { ...base, status: 'failed', violations: [], error: (error as Error).message };
    }
  }

  /**
   * 검사 대상이 아닌 리소스 타입을 찾는다.
   *
   * §9.1로 추가된 신규 모듈(`board.post` 등)의 정상 Grant 를 "화이트리스트 밖"으로 판정하면
   * L-1 이 **전량 삭제**한다. 그래서 미등록 타입은 위반이 아니라 **검사 불가(L-3 보고)** 다.
   */
  private async findUnknownResourceTypes(tx: Prisma.TransactionClient, known: string[]): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ resource_type: string }>>`
      SELECT DISTINCT resource_type FROM resource_grants
       WHERE resource_type <> ALL (${known}::text[])`;
    return rows.map((r) => r.resource_type);
  }

  /** 심각도별 대응 (§14.4의 L-1/L-2/L-3 + 즉시 호출) */
  private async respond(
    tx: Prisma.TransactionClient,
    checks: CheckResult[],
    unknownResourceTypes: string[],
  ): Promise<{ remediated: number; escalated: string[] }> {
    let remediated = 0;
    const escalated: string[] = [];
    // Grant 조회는 전용 통로(GrantStore)를 경유한다 — G-2 룰을 느슨하게 하지 않기 위해
    const totalGrants = await this.grantStore.countAll(tx);

    for (const check of checks) {
      if (check.status === 'failed') {
        await this.notifier.send({
          level: 'PAGE',
          title: `${check.id} 검사 실패 — 감시 공백`,
          body: check.error ?? '알 수 없는 오류',
        });
        continue;
      }
      if (check.status !== 'violated') continue;

      if (check.severity === 'L1') {
        const cap = Math.max(BLAST_RADIUS_ROWS, Math.floor(totalGrants * BLAST_RADIUS_RATIO));
        if (check.violations.length > cap) {
          // 대량 위반은 데이터 이상이 아니라 불변식 정의가 현실과 어긋났다는 신호다(WT-11)
          escalated.push(check.id);
          await this.notifier.send({
            level: 'L2',
            title: `${check.id} 자동 조치 중단 — 조치 대상 ${check.violations.length}건이 상한(${cap})을 초과`,
            body: '불변식 정의가 현실과 어긋났을 가능성이 큽니다. 사람이 확인해야 합니다.',
            detail: { sample: check.violations.slice(0, 5) },
          });
          continue;
        }
        remediated += await this.remediate(tx, check);
        continue;
      }

      await this.notifier.send({
        level: check.severity === 'PAGE' ? 'PAGE' : check.severity,
        title: `${check.id} 위반 ${check.violations.length}건 — ${check.title}`,
        body: check.severity === 'PAGE'
          ? '자동 조치 대상이 아닙니다. break-glass 런북 절차를 확인하세요.'
          : '확인이 필요합니다.',
        detail: { sample: check.violations.slice(0, 5) },
      });
    }

    if (unknownResourceTypes.length > 0) {
      await this.notifier.send({
        level: 'L3',
        title: '검사 불가 리소스 타입',
        body: `${unknownResourceTypes.join(', ')} — 화이트리스트 미등록. 위반으로 판정하지 않았습니다.`,
      });
    }
    return { remediated, escalated };
  }

  /**
   * L-1 자동 회수. **회수는 SQL 이 아니라 `ResourceGrantService` 를 경유한다**(§1.3-5) —
   * 그래야 회수 전 행 전체가 `detail.before` 로 감사에 남아 복구 스크립트로 되돌릴 수 있고,
   * G-2의 "권한 테이블 직접 변경 금지" 룰도 느슨해지지 않는다.
   */
  private async remediate(tx: Prisma.TransactionClient, check: CheckResult): Promise<number> {
    let count = 0;
    for (const violation of check.violations) {
      await this.grants.revoke(tx, {
        tenantId: DEFAULT_TENANT_ID,
        actorId: null,
        grantId: violation.subject,
        reason: `${check.id} 자동 회수 (${String(violation.detail.reason ?? check.title)})`,
      });
      count += 1;
    }
    await this.notifier.send({
      level: 'L1',
      title: `${check.id} 자동 회수 ${count}건`,
      body: '회수 전 행 내용이 감사 로그에 남아 있어 복구 가능합니다(scripts/restore-grants.ts).',
      detail: { sample: check.violations.slice(0, 5) },
    });
    return count;
  }

  /**
   * 만료된 Grant 물리 정리 (작업지시서 WP-14-5).
   *
   * **고아 Grant 정리와 역할이 겹치지 않는다** — 고아는 10분 순찰의 RI-4가 즉시 지우므로
   * 주기 배치로 두면 항상 0건이 되어 "동작 확인"이 형식 통과가 된다(WT-35).
   * 여기서는 `expires_at` 이 지난 행만 맡는다. 만료 Grant 는 평가기가 이미 무효로 보지만,
   * 행이 계속 쌓이면 조회 비용과 감사 추적이 함께 나빠진다.
   */
  @Cron('50 4 * * *')
  async purgeExpiredGrants(): Promise<number> {
    // 한 번에 무제한 삭제하지 않는다 — 남은 분량은 다음 실행이 맡는다.
    // 조회는 전용 통로(GrantStore)를 경유한다(G-2)
    const expired = await this.grantStore.findExpired(500);
    if (expired.length === 0) return 0;

    let purged = 0;
    for (const grantId of expired) {
      // 회수는 반드시 서비스를 경유한다 — 회수 전 행이 감사에 남아야 복구 가능하다
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await this.grants.revoke(tx, {
          tenantId: DEFAULT_TENANT_ID, actorId: null, grantId,
          reason: '만료 Grant 정리 배치',
        });
      });
      purged += 1;
    }
    this.logger.log(`만료 Grant ${purged}건 정리`);
    return purged;
  }

  private emptyResult(skipped: 'lock' | 'overlap'): PatrolResult {
    return {
      startedAt: new Date().toISOString(),
      durationMs: 0,
      skipped,
      checks: [],
      remediated: 0,
      escalated: [],
      unknownResourceTypes: [],
    };
  }
}
