import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { PolicyService, TransferReason } from '../authorization/policy.service';
import { PrismaGrantStore } from '../authorization/grant.store';
import { SubjectSnapshot } from '../authorization/types';

/** 발의 유효 기간 (기획서 DOM-6 기본 7일) */
const TRANSFER_TTL_MS = Number(process.env.DOMAIN_TRANSFER_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);

export interface TransferSummary {
  id: string;
  domainId: string;
  fqdn: string;
  fromUserId: string;
  toUserId: string;
  status: string;
  reason: string | null;
  expiresAt: string;
  createdAt: string;
}

/** 거부 사유 → 사용자에게 보여줄 문장. 내부 상태를 그대로 노출하지 않는다 */
const REASON_TEXT: Record<TransferReason, string> = {
  OK: '',
  NOT_RECIPIENT: '이 발의의 수령자가 아닙니다.',
  NOT_PENDING: '이미 종료된 발의입니다.',
  EXPIRED: '발의가 만료되었습니다.',
  PROPOSER_NOT_OWNER: '발의자가 더 이상 이 도메인의 소유자가 아닙니다.',
  PROPOSER_INACTIVE: '발의자 계정이 활성 상태가 아닙니다.',
  DOMAIN_STATE: '이전할 수 없는 상태의 도메인입니다.',
  RECIPIENT_DENIED: '이 도메인에 대한 차단(DENY)이 설정된 계정으로는 이전받을 수 없습니다.',
};

interface LockedDomain {
  id: string;
  tenant_id: string;
  owner_id: string;
  status: string;
  deleted_at: Date | null;
}

/**
 * 도메인 소유자 이전 (기획서 §6.4 DOM-6) — **발의 + 수락의 2단계**.
 *
 * 상태는 신규 테이블 `domain_transfers` 에만 담는다(INV-7 — 기존 테이블 무변경).
 * 수락 경로는 §7.3의 **인증 게이트형**이라 평가기가 실행되지 않으므로,
 * `PolicyService.canAcceptTransfer` 가 잠근 뒤 읽은 상태로 검증을 재현한다(WT-8).
 */
@Injectable()
export class DomainTransfersService {
  private readonly logger = new Logger(DomainTransfersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly grants: ResourceGrantService,
    private readonly policy: PolicyService,
    private readonly grantStore: PrismaGrantStore,
  ) {}

  // ── 발의 ──────────────────────────────────────────────────────
  async propose(subject: SubjectSnapshot, domainId: string, toUserId: string): Promise<TransferSummary> {
    if (toUserId === subject.id) {
      throw new BadRequestException('자신에게 이전할 수 없습니다.');
    }
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain || domain.deleted_at) throw new NotFoundException();

    const recipient = await this.prisma.user.findUnique({ where: { id: toUserId } });
    // 다른 테넌트·탈퇴·정지 계정으로의 이전은 발의 단계에서 끊는다. 수락 시점에도 다시 보지만,
    // 여기서 막지 않으면 존재하지 않는 대상 앞으로 발의가 쌓여 부분 유니크 슬롯만 낭비된다.
    if (!recipient || recipient.deleted_at || recipient.tenant_id !== subject.tenantId) {
      throw new NotFoundException();
    }
    if (recipient.status !== 'ACTIVE') {
      throw new ConflictException('활성 상태가 아닌 계정으로는 이전할 수 없습니다.');
    }

    // **만료된 PENDING 발의를 먼저 정리한다.** 부분 유니크가 (domain_id) WHERE status='PENDING'
    // 이므로, 만료된 채 남은 발의 하나가 그 도메인의 재발의를 영구히 막는다.
    // 스윕 크론이 멈춰도 이 지연 만료가 있으면 사용자가 갇히지 않는다.
    await this.expireStale(domainId);

    const created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const pending = await tx.domainTransfer.findFirst({
        where: { domain_id: domainId, status: 'PENDING' },
        select: { id: true },
      });
      if (pending) throw new ConflictException('이미 진행 중인 이전 발의가 있습니다.');

      const row = await tx.domainTransfer.create({
        data: {
          tenant_id: subject.tenantId,
          domain_id: domainId,
          from_user_id: subject.id,
          to_user_id: toUserId,
          status: 'PENDING',
          expires_at: new Date(Date.now() + TRANSFER_TTL_MS),
        },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'domain.transfer.propose',
        targetType: 'domain', targetId: domainId,
        detail: { before: { owner: domain.owner_id }, after: { to: toUserId, transferId: row.id } },
      });
      return row;
    });
    return this.toSummary(created, domain.fqdn);
  }

  // ── 수락 ──────────────────────────────────────────────────────
  /**
   * 수락. **도메인 행을 먼저 잠근 뒤** 발의·발의자·도메인 상태를 다시 읽어 검증한다.
   * 잠금 없이 검증하면 검증과 소유권 변경 사이에 삭제·재이전이 끼어들 수 있다.
   */
  async accept(subject: SubjectSnapshot, transferId: string): Promise<TransferSummary> {
    const transfer = await this.prisma.domainTransfer.findUnique({ where: { id: transferId } });
    // 수령자가 아닌 사람에게는 발의의 존재 자체를 숨긴다(§10.2)
    if (!transfer || transfer.to_user_id !== subject.id) throw new NotFoundException();

    // 판정 결과를 트랜잭션 **밖으로** 들고 나온다.
    // 거부 시의 "발의 무효 종료"를 같은 트랜잭션 안에서 쓰고 예외를 던지면, 롤백으로 그 기록이
    // 함께 사라져 발의가 PENDING 으로 남는다 — 부분 유니크 슬롯을 계속 점유하게 된다.
    const outcome = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const locked = await tx.$queryRaw<LockedDomain[]>`
        SELECT id, tenant_id, owner_id, status, deleted_at
          FROM domains WHERE id = ${transfer.domain_id}::uuid FOR UPDATE`;
      const current = await tx.domainTransfer.findUniqueOrThrow({ where: { id: transferId } });

      const domain = locked[0];
      if (!domain || domain.deleted_at !== null || domain.tenant_id !== subject.tenantId) {
        return { ok: false as const, reason: 'DOMAIN_STATE' as TransferReason, notFound: true };
      }

      const proposer = await tx.user.findUnique({
        where: { id: current.from_user_id },
        select: { status: true, deleted_at: true },
      });
      // 수령자에게 걸린 유효한 DENY 는 소유권을 넘겨도 사라지지 않는다(INV-4) — 미리 본다
      const recipientGrants = await this.grantStore.findSubjectGrants(subject.id, 'domain');
      const recipientDenied = recipientGrants.some(
        (g) => g.resourceId === domain.id && g.effect === 'DENY',
      );

      const decision = this.policy.canAcceptTransfer(subject, {
        toUserId: current.to_user_id,
        transferStatus: current.status,
        expiresAt: current.expires_at,
        proposerId: current.from_user_id,
        proposerStatus: proposer && !proposer.deleted_at ? proposer.status : 'DELETED',
        domainOwnerId: domain.owner_id,
        domainStatus: domain.status,
        recipientDenied,
        now: new Date(),
      });

      if (!decision.allowed) {
        return { ok: false as const, reason: decision.reason, notFound: false };
      }

      await tx.domain.update({
        where: { id: domain.id },
        data: { owner_id: current.to_user_id },
      });
      // **ALLOW 는 전체 삭제, DENY 는 승계**(기획서 DOM-6). DENY 는 리소스에 걸린 제재이지
      // 소유자에 걸린 것이 아니라, 함께 지우면 소유권 왕복만으로 제재가 해제된다.
      await this.grants.cleanupForResource(tx, 'domain', domain.id, {
        tenantId: subject.tenantId, actorId: subject.id, keepDeny: true,
      });
      const updated = await tx.domainTransfer.update({
        where: { id: current.id },
        data: { status: 'ACCEPTED', finished_at: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'domain.transfer.accept',
        targetType: 'domain', targetId: domain.id,
        detail: {
          before: { owner: domain.owner_id },
          after: { owner: current.to_user_id, transferId: current.id },
        },
      });
      return { ok: true as const, transfer: updated };
    });

    if (!outcome.ok) {
      // 재검증에서 걸린 발의는 되살릴 수 없다 — 사유와 함께 무효 종료시킨다(WT-8).
      // 별도 트랜잭션이라 위 롤백에 휩쓸리지 않는다.
      await this.invalidateNow(transfer.id, subject, REASON_TEXT[outcome.reason]);
      if (outcome.notFound) throw new NotFoundException();
      throw new ForbiddenException(REASON_TEXT[outcome.reason]);
    }

    const domain = await this.prisma.domain.findUniqueOrThrow({ where: { id: outcome.transfer.domain_id } });
    return this.toSummary(outcome.transfer, domain.fqdn);
  }

  // ── 취소 ──────────────────────────────────────────────────────
  /** 발의자(= 소유자)가 수락 전에 거둬들인다. 게이트는 `domain.transfer`(owned) */
  async cancel(subject: SubjectSnapshot, domainId: string, transferId: string): Promise<void> {
    const transfer = await this.prisma.domainTransfer.findUnique({ where: { id: transferId } });
    if (!transfer || transfer.domain_id !== domainId) throw new NotFoundException();
    if (transfer.status !== 'PENDING') throw new ConflictException('이미 종료된 발의입니다.');

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.domainTransfer.update({
        where: { id: transferId },
        data: { status: 'CANCELLED', finished_at: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'domain.transfer.cancel',
        targetType: 'domain', targetId: domainId,
        detail: { before: { transferId, status: 'PENDING' }, after: { status: 'CANCELLED' } },
      });
    });
  }

  // ── 조회 ──────────────────────────────────────────────────────
  /** 내가 보낸·받은 발의. 인증만으로 접근하므로 **행 범위를 여기서 강제한다**(컬렉션 규약) */
  async listMine(subject: SubjectSnapshot): Promise<TransferSummary[]> {
    const rows = await this.prisma.domainTransfer.findMany({
      where: {
        tenant_id: subject.tenantId,
        OR: [{ from_user_id: subject.id }, { to_user_id: subject.id }],
      },
      include: { domain: { select: { fqdn: true } } },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.toSummary(r, r.domain.fqdn));
  }

  // ── 만료 ──────────────────────────────────────────────────────
  /** 만료 스윕. 지연 만료(propose 시)와 이중으로 두어 어느 한쪽이 멈춰도 갇히지 않게 한다 */
  @Cron('40 4 * * *')
  async sweepExpired(): Promise<number> {
    const { count } = await this.prisma.domainTransfer.updateMany({
      where: { status: 'PENDING', expires_at: { lte: new Date() } },
      data: { status: 'EXPIRED', reason: REASON_TEXT.EXPIRED, finished_at: new Date() },
    });
    if (count > 0) this.logger.log(`만료된 이전 발의 ${count}건 정리`);
    return count;
  }

  private async expireStale(domainId: string): Promise<void> {
    await this.prisma.domainTransfer.updateMany({
      where: { domain_id: domainId, status: 'PENDING', expires_at: { lte: new Date() } },
      data: { status: 'EXPIRED', reason: REASON_TEXT.EXPIRED, finished_at: new Date() },
    });
  }

  /**
   * 발의를 무효 종료시킨다. `status='PENDING'` 조건을 붙여 경합 시 한 번만 성립하게 한다.
   * 무효 종료도 감사 대상이다 — "왜 이전이 무산됐는가"는 나중에 반드시 묻게 되는 질문이다.
   */
  private async invalidateNow(id: string, subject: SubjectSnapshot, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const { count } = await tx.domainTransfer.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'INVALIDATED', reason, finished_at: new Date() },
      });
      if (count === 0) return;
      const row = await tx.domainTransfer.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'domain.transfer.invalidate',
        targetType: 'domain', targetId: row.domain_id,
        detail: { before: { transferId: id, status: 'PENDING' }, after: { status: 'INVALIDATED', reason } },
      });
    });
  }

  private toSummary(
    row: {
      id: string; domain_id: string; from_user_id: string; to_user_id: string;
      status: string; reason: string | null; expires_at: Date; created_at: Date;
    },
    fqdn: string,
  ): TransferSummary {
    return {
      id: row.id,
      domainId: row.domain_id,
      fqdn,
      fromUserId: row.from_user_id,
      toUserId: row.to_user_id,
      status: row.status,
      reason: row.reason,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    };
  }
}
