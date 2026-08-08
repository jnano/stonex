import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { DNS_TXT_RESOLVER, DnsTxtResolver } from './dns-resolver';
import { txtRecordValue } from './fqdn';

/** 검증 요청 제한 (작업지시서 WP-12-2). 값은 환경 변수로만 바꾼다 */
const COOLDOWN_MS = Number(process.env.DOMAIN_VERIFY_COOLDOWN_MS ?? 30_000);
const DAILY_LIMIT = Number(process.env.DOMAIN_VERIFY_DAILY_LIMIT ?? 20);
/** 한 번의 워커 틱에서 처리할 잡 수 — DNS 조회가 직렬이므로 상한을 둔다 */
const BATCH_SIZE = Number(process.env.DOMAIN_VERIFY_BATCH ?? 5);
/** 검증 결과를 조회할 때 돌려줄 최근 시도 건수 */
const HISTORY_SIZE = 10;

export interface VerificationAttemptView {
  id: string;
  state: string;
  reason: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface ClaimedJob {
  id: string;
  domain_id: string;
  tenant_id: string;
  requested_by: string;
}

/**
 * 도메인 소유권 검증 (기획서 §6.4 DOM-3).
 *
 * **API 는 잡을 적재하고 즉시 202 를 반환한다.** DNS 조회를 요청 스레드에서 하면 상위 리졸버가
 * 느려질 때 요청 하나가 워커를 최대 3초씩 점유하고, 그런 요청이 몰리면 API 전체가 포화된다.
 * 큐 미들웨어를 새로 들이는 대신 `domain_verification_attempts` 를 잡 테이블로 겸용한다 —
 * 검증은 도메인당 하루 수 건 규모라 큐의 처리량 이점이 없고, 감사 파티션·업로드 GC 와 같은
 * `@nestjs/schedule` 패턴 하나로 배치 인프라가 유지된다.
 */
@Injectable()
export class DomainVerificationService {
  private readonly logger = new Logger(DomainVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(DNS_TXT_RESOLVER) private readonly dns: DnsTxtResolver,
  ) {}

  // ── 요청 (즉시 반환) ──────────────────────────────────────────
  async request(subject: SubjectSnapshot, domainId: string): Promise<{ attemptId: string; state: string }> {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain || domain.deleted_at) throw new NotFoundException();

    // 이미 진행 중인 시도가 있으면 그것을 돌려준다 — 부분 유니크(uq_domain_verification_inflight)가
    // 어차피 두 번째 적재를 막으므로, 여기서 멱등 처리하지 않으면 사용자에게 DB 오류가 노출된다.
    const inflight = await this.prisma.domainVerificationAttempt.findFirst({
      where: { domain_id: domainId, state: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true, state: true },
    });
    if (inflight) return { attemptId: inflight.id, state: inflight.state };

    // **종결 조건을 속도 제한보다 먼저 본다.** 순서를 뒤집으면 다시는 검증할 수 없는 도메인에
    // "30초 뒤 다시 시도하세요"(429)를 돌려주게 되어, 사용자가 영원히 재시도하게 된다.
    // 검증 성공 시 토큰을 폐기하므로(재사용 방지), 토큰이 없다는 것은 이미 검증됐다는 뜻이다.
    if (!domain.verify_token) {
      const message =
        domain.status === 'VERIFIED'
          ? '이미 검증된 도메인입니다.'
          : '검증 토큰이 없습니다. 도메인 주소를 다시 저장하면 토큰이 재발급됩니다.';
      throw new HttpException(message, HttpStatus.CONFLICT);
    }

    const now = Date.now();
    const recent = await this.prisma.domainVerificationAttempt.findFirst({
      where: { domain_id: domainId },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });
    if (recent && now - recent.created_at.getTime() < COOLDOWN_MS) {
      throw new HttpException(
        `검증은 ${Math.ceil(COOLDOWN_MS / 1000)}초에 한 번만 요청할 수 있습니다.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const todayCount = await this.prisma.domainVerificationAttempt.count({
      where: { domain_id: domainId, created_at: { gt: new Date(now - 24 * 60 * 60 * 1000) } },
    });
    if (todayCount >= DAILY_LIMIT) {
      throw new HttpException('하루 검증 요청 한도를 초과했습니다.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const attempt = await this.prisma.domainVerificationAttempt.create({
      data: {
        tenant_id: subject.tenantId,
        domain_id: domainId,
        requested_by: subject.id,
        method: 'DNS_TXT',
        state: 'PENDING',
      },
      select: { id: true, state: true },
    });
    return { attemptId: attempt.id, state: attempt.state };
  }

  /** 검증 이력 조회 — 실패 사유는 감사 로그가 아니라 여기에 남는다 */
  async history(domainId: string): Promise<VerificationAttemptView[]> {
    const rows = await this.prisma.domainVerificationAttempt.findMany({
      where: { domain_id: domainId },
      orderBy: { created_at: 'desc' },
      take: HISTORY_SIZE,
    });
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
    }));
  }

  // ── 워커 ──────────────────────────────────────────────────────
  @Interval(10_000)
  async processPending(): Promise<number> {
    let processed = 0;
    for (let i = 0; i < BATCH_SIZE; i += 1) {
      const job = await this.claim();
      if (!job) break;
      await this.run(job);
      processed += 1;
    }
    return processed;
  }

  /**
   * 잡 1건을 원자적으로 선점한다.
   * `FOR UPDATE SKIP LOCKED` 로 집어야 워커가 여러 개(다중 인스턴스)여도 같은 잡을 중복 처리하지
   * 않는다. "조회 후 UPDATE" 로 짜면 두 인스턴스가 같은 행을 집어 DNS 조회를 두 배로 낸다.
   */
  private async claim(): Promise<ClaimedJob | null> {
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE domain_verification_attempts
         SET state = 'RUNNING'
       WHERE id = (
         SELECT id FROM domain_verification_attempts
          WHERE state = 'PENDING'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, domain_id, tenant_id, requested_by`;
    return rows[0] ?? null;
  }

  /** 선점한 잡 1건 실행. 예외를 밖으로 던지지 않는다 — 던지면 잡이 RUNNING 으로 굳는다 */
  private async run(job: ClaimedJob): Promise<void> {
    try {
      const domain = await this.prisma.domain.findUnique({ where: { id: job.domain_id } });
      if (!domain || domain.deleted_at || !domain.verify_token) {
        await this.finish(job, false, '도메인을 확인할 수 없습니다.');
        return;
      }

      const expected = txtRecordValue(domain.verify_token);
      const records = await this.dns.resolveTxt(`_stonex-challenge.${domain.fqdn}`);
      if (!records.includes(expected)) {
        await this.finish(job, false, 'TXT 레코드를 찾지 못했습니다.');
        return;
      }

      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // **토큰을 폐기한다** — 남겨두면 같은 값으로 반복 검증이 가능해지고, 그 값이 다른
        // 도메인의 DNS 에 복사되어도 통과한다(토큰 재사용).
        await tx.domain.update({
          where: { id: domain.id },
          data: { status: 'VERIFIED', verified_at: new Date(), verify_token: null },
        });
        await tx.domainVerificationAttempt.update({
          where: { id: job.id },
          data: { state: 'SUCCEEDED', reason: null, finished_at: new Date() },
        });
        // 성공만 감사에 남긴다. 실패는 사용자의 DNS 설정 오류가 대부분이라 빈도가 높아,
        // 감사 로그(권한 변경의 법적 기록)에 섞이면 추적 신호가 묻힌다.
        await this.audit.record(tx, {
          tenantId: job.tenant_id, actorId: job.requested_by, action: 'domain.verify',
          targetType: 'domain', targetId: domain.id,
          detail: { before: { status: domain.status }, after: { status: 'VERIFIED' } },
        });
      });
    } catch (error) {
      this.logger.warn(`도메인 검증 잡 실패 ${job.id}: ${(error as Error).message}`);
      await this.finish(job, false, '검증 처리 중 오류가 발생했습니다.').catch(() => undefined);
    }
  }

  private async finish(job: ClaimedJob, ok: boolean, reason: string | null): Promise<void> {
    await this.prisma.domainVerificationAttempt.update({
      where: { id: job.id },
      data: { state: ok ? 'SUCCEEDED' : 'FAILED', reason, finished_at: new Date() },
    });
  }
}
