import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { PolicyService } from '../authorization/policy.service';
import { PrismaGrantStore } from '../authorization/grant.store';
import { SubjectSnapshot } from '../authorization/types';

export interface DelegationSummary {
  grantId: string;
  subjectId: string;
  permission: string;
  expiresAt: string | null;
  grantedBy: string;
  grantedAt: string;
}

/** 위임에 반드시 포함되는 권한 (기획서 DOM-5·RT-14) */
const ALWAYS_INCLUDED = 'domain.read';

/**
 * 도메인 운영 위임 (기획서 §6.4 DOM-5).
 *
 * **파일 공유와 동일한 `ResourceGrantService` 경로를 재사용한다** — 도메인 전용 공유 로직을
 * 새로 만드는 것은 §9.1 위반이며, 화이트리스트·자기부여 금지·행 잠금·감사 기록이 두 벌이 된다.
 * 여기서는 도메인 고유의 관계 규칙만 다룬다.
 */
@Injectable()
export class DomainDelegationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: ResourceGrantService,
    private readonly policy: PolicyService,
    private readonly grantStore: PrismaGrantStore,
  ) {}

  /**
   * 위임 생성. 게이트는 `domain.share`(owned)이므로 소유자만 도달한다.
   *
   * **`domain.read` 를 항상 포함시킨다**(RT-14). read 없이 update 만 주면 수임자는 §10.2의
   * 존재 은닉 때문에 대상 도메인을 목록·상세에서 404 로 보면서 수정만 가능한 운영 불능 상태가 된다.
   * `domain.share` 는 화이트리스트에 없어 **재위임이 원천 차단**되고, `domain.transfer`·
   * `domain.delete` 도 같은 이유로 위임되지 않는다(`ResourceGrantService` 가 거부한다).
   */
  async create(
    subject: SubjectSnapshot,
    domainId: string,
    input: { subjectId: string; permissions: string[]; expiresAt?: Date | null },
  ): Promise<DelegationSummary[]> {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain || domain.deleted_at) throw new NotFoundException();

    const permissions = [...new Set([ALWAYS_INCLUDED, ...input.permissions])];

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.grants.create(tx, {
        tenantId: subject.tenantId,
        actorId: subject.id,
        subjectId: input.subjectId,
        resourceType: 'domain',
        resourceId: domainId,
        permissionCodes: permissions,
        expiresAt: input.expiresAt ?? null,
      });
    });
    return this.list(subject, domainId);
  }

  /** 특정 도메인의 위임 목록 — 소유자·관리자만 볼 수 있다 */
  async list(subject: SubjectSnapshot, domainId: string): Promise<DelegationSummary[]> {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain || domain.deleted_at) throw new NotFoundException();
    if (domain.owner_id !== subject.id && !subject.permissions.has('domain.share.all')) {
      throw new NotFoundException(); // 존재 은닉(§10.2)
    }
    const rows = await this.grantStore.findByResource('domain', domainId);
    return rows.map((g) => ({
      grantId: g.id,
      subjectId: g.subject_id,
      permission: g.permission.code,
      expiresAt: g.expires_at?.toISOString() ?? null,
      grantedBy: g.granted_by,
      grantedAt: g.granted_at.toISOString(),
    }));
  }

  /**
   * 위임 회수 — 관계형 2차 인가(§7.3). 규칙은 파일 공유 회수와 같은 정책 함수를 쓴다.
   * 관리자 분기(`domain.share.all`)는 소유자 계정이 정지됐을 때 유출된 위임을 끊는 유일한 경로다.
   */
  async revoke(subject: SubjectSnapshot, domainId: string, grantId: string): Promise<void> {
    const grant = await this.grantStore.findById(grantId);
    if (!grant || grant.resource_id !== domainId || grant.resource_type !== 'domain') {
      throw new NotFoundException();
    }
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain || domain.deleted_at) throw new NotFoundException();

    const decision = this.policy.canRevokeShare(subject, {
      resourceType: 'domain',
      ownerId: domain.owner_id,
      grantedBy: grant.granted_by,
    });
    if (!decision.allowed) throw new ForbiddenException();

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.grants.revoke(tx, {
        tenantId: subject.tenantId, actorId: subject.id, grantId,
      });
    });
  }
}
