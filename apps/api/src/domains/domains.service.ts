import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { PrismaGrantStore } from '../authorization/grant.store';
import { statusesAllowing } from '../authorization/authorization.service';
import { SubjectSnapshot } from '../authorization/types';
import { DomainSummary, toDomainSummary } from './domain.serializer';
import { normalizeFqdn } from './fqdn';

/** 검증 토큰 — 32바이트 난수. base64url 43자로 VarChar(64) 안에 들어간다 */
function issueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 도메인 관리 (기획서 §6.4 DOM-1·2·4·7).
 * 소유권 검증(DOM-3)은 외부 I/O 를 다루므로 `DomainVerificationService` 로 분리했다.
 */
@Injectable()
export class DomainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly grants: ResourceGrantService,
    private readonly grantStore: PrismaGrantStore,
  ) {}

  // ── DOM-2 등록 ────────────────────────────────────────────────
  /**
   * `domain.create` 는 global scope 다 — 등록 시점에는 대상 리소스가 없어 owned 로 게이트할 수
   * 없기 때문이다(§4.3). 따라서 "누가 도메인을 만들 수 있는가"는 전적으로 역할 매핑이 정한다.
   */
  async create(subject: SubjectSnapshot, rawFqdn: string): Promise<DomainSummary> {
    const fqdn = normalizeFqdn(rawFqdn);

    const domain = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 살아있는 행만 유일성 대상이다(uq_domains_fqdn_live) — 삭제된 도메인은 재등록할 수 있다.
      const live = await tx.domain.findFirst({
        where: { tenant_id: subject.tenantId, fqdn, deleted_at: null },
        select: { id: true },
      });
      if (live) throw new ConflictException('이미 등록된 도메인입니다.');

      const created = await tx.domain.create({
        data: {
          tenant_id: subject.tenantId,
          owner_id: subject.id,
          fqdn,
          status: 'UNVERIFIED',
          verify_token: issueToken(),
        },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'domain.create',
        targetType: 'domain', targetId: created.id,
        detail: { before: {}, after: { fqdn, status: 'UNVERIFIED' } },
      });
      return created;
    });
    return toDomainSummary(domain, subject.id);
  }

  // ── DOM-1 조회 ────────────────────────────────────────────────
  /**
   * 회원용 목록 (컬렉션 규약 §7.3) — 게이트는 인증뿐이고 행 범위를 여기서 강제한다.
   * 쿼리 조건은 평가기 0~4단계와 등가여야 한다(§7.3-2).
   *
   * 파일 목록과 한 가지가 다르다: **도메인은 조회 가능한 상태가 접근 가능한 상태보다 넓다.**
   * SUSPENDED 도메인은 `readExtra` 예외로 조회만 허용되므로(§4.7 1단계), 목록에서 빼면
   * "상세는 보이는데 목록에는 없는" 불일치가 생긴다. 상태 집합을 평가기 표에서 가져오는 이유다.
   */
  async listVisible(subject: SubjectSnapshot, page = 1, size = 20): Promise<{ items: DomainSummary[]; total: number }> {
    const take = Math.min(Math.max(size, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;

    const validGrants = await this.grantStore.findSubjectGrants(subject.id, 'domain');
    const allowIds = new Set(validGrants.filter((g) => g.effect === 'ALLOW').map((g) => g.resourceId));
    const denyIds = new Set(validGrants.filter((g) => g.effect === 'DENY').map((g) => g.resourceId));
    // DENY 는 소유자 경로보다 우선한다(INV-4)
    for (const id of denyIds) allowIds.delete(id);

    const where: Prisma.DomainWhereInput = {
      tenant_id: subject.tenantId,
      status: { in: [...statusesAllowing('domain', 'domain.read')] },
      deleted_at: null,
      OR: [{ owner_id: subject.id }, { id: { in: [...allowIds] } }],
      ...(denyIds.size > 0 ? { NOT: { id: { in: [...denyIds] } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.domain.findMany({ where, orderBy: { created_at: 'desc' }, skip, take }),
      this.prisma.domain.count({ where }),
    ]);
    return { items: rows.map((d) => toDomainSummary(d, subject.id)), total };
  }

  /** 관리자 전체 목록 — `/admin/domains` 에서 `domain.read.all` 로 게이트한다(라우트 분리) */
  async listAll(subject: SubjectSnapshot, page = 1, size = 20): Promise<{ items: DomainSummary[]; total: number }> {
    const take = Math.min(Math.max(size, 1), 100);
    const where: Prisma.DomainWhereInput = { tenant_id: subject.tenantId, deleted_at: null };
    const [rows, total] = await Promise.all([
      this.prisma.domain.findMany({
        where, orderBy: { created_at: 'desc' }, skip: (Math.max(page, 1) - 1) * take, take,
      }),
      this.prisma.domain.count({ where }),
    ]);
    return { items: rows.map((d) => toDomainSummary(d, subject.id)), total };
  }

  async detail(domainId: string, viewerId: string): Promise<DomainSummary> {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain || domain.deleted_at) throw new NotFoundException();
    return toDomainSummary(domain, viewerId);
  }

  // ── DOM-4 수정 ────────────────────────────────────────────────
  /**
   * FQDN 변경은 **검증 결과를 반드시 무효화한다**(UNVERIFIED + 토큰 재발급 + verified_at 초기화).
   * 그렇지 않으면 자기 소유 도메인 하나를 검증한 뒤 이름만 갈아끼워 임의 도메인의 소유권을
   * 자칭할 수 있다 — 검증 절차 전체를 우회하는 경로다.
   */
  async update(subject: SubjectSnapshot, domainId: string, rawFqdn: string): Promise<DomainSummary> {
    const fqdn = normalizeFqdn(rawFqdn);
    const before = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!before || before.deleted_at) throw new NotFoundException();

    if (before.fqdn === fqdn) return toDomainSummary(before, subject.id);

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const conflict = await tx.domain.findFirst({
        where: { tenant_id: before.tenant_id, fqdn, deleted_at: null, NOT: { id: domainId } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException('이미 등록된 도메인입니다.');

      await tx.domain.update({
        where: { id: domainId },
        data: { fqdn, status: 'UNVERIFIED', verify_token: issueToken(), verified_at: null },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'domain.update',
        targetType: 'domain', targetId: domainId,
        detail: {
          before: { fqdn: before.fqdn, status: before.status },
          after: { fqdn, status: 'UNVERIFIED' },
        },
      });
    });
    return this.detail(domainId, subject.id);
  }

  // ── DOM-7 삭제 ────────────────────────────────────────────────
  /** 소프트 삭제 — `status='DELETED'` 와 `deleted_at` 을 동시에 설정한다(파일과 공통, WT-25) */
  async softDelete(subject: SubjectSnapshot, domainId: string): Promise<void> {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain || domain.deleted_at) throw new NotFoundException();

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.domain.update({
        where: { id: domainId },
        // 토큰도 함께 폐기한다 — 삭제된 도메인의 토큰이 살아 있으면, 같은 FQDN 을 재등록한
        // 다른 사람의 DNS 에 옛 토큰이 남아 있는 상황에서 검증이 오작동할 수 있다.
        data: { status: 'DELETED', deleted_at: new Date(), verify_token: null },
      });
      // 진행 중인 검증 잡을 종료시킨다 — 삭제된 도메인을 워커가 계속 집으면
      // 부분 유니크(uq_domain_verification_inflight)가 재등록 후 첫 검증까지 막는다.
      await tx.domainVerificationAttempt.updateMany({
        where: { domain_id: domainId, state: { in: ['PENDING', 'RUNNING'] } },
        data: { state: 'FAILED', reason: '도메인이 삭제되었습니다.', finished_at: new Date() },
      });
      await this.grants.cleanupForResource(tx, 'domain', domainId, {
        tenantId: subject.tenantId, actorId: subject.id,
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'domain.delete',
        targetType: 'domain', targetId: domainId,
        detail: { before: { fqdn: domain.fqdn, status: domain.status }, after: { status: 'DELETED' } },
      });
    });
  }
}
