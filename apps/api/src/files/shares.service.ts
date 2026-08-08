import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { PolicyService } from '../authorization/policy.service';
import { PrismaGrantStore } from '../authorization/grant.store';
import { SubjectSnapshot } from '../authorization/types';

export interface ShareSummary {
  grantId: string;
  subjectId: string;
  permission: string;
  expiresAt: string | null;
  grantedBy: string;
  grantedAt: string;
}

/** 관리자 경로 Grant 의 최대 수명 (WT-7 — 부여자가 강등돼도 Grant 는 남으므로 잔존 창을 유한하게) */
const ADMIN_GRANT_MAX_DAYS = 30;

/**
 * 파일 공유 (기획서 §6.3 FILE-3~5).
 *
 * 공유 생성·회수는 전부 `ResourceGrantService` 를 경유한다 — 화이트리스트·자기부여 금지·
 * effect 고정·행 잠금이 그 안에 모여 있다. 여기서는 **관계 규칙과 경로 판정**만 다룬다.
 */
@Injectable()
export class SharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: ResourceGrantService,
    private readonly policy: PolicyService,
    private readonly grantStore: PrismaGrantStore,
  ) {}

  /**
   * FILE-4 공유 생성.
   *
   * 경로가 두 가지다: 소유자(`file.share`, owned)와 관리자(`file.share.all`, global).
   * Guard 는 소유자 경로만 통과시키므로, 관리자 경로는 여기서 판정한다 —
   * `file.share` 는 owned scope 라 관리자가 타인 파일에 대해 통과할 수 없기 때문이다.
   */
  async create(
    subject: SubjectSnapshot,
    fileId: string,
    input: { subjectId: string; permissions: string[]; expiresAt?: Date | null },
  ): Promise<ShareSummary[]> {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.deleted_at) throw new NotFoundException();

    const isOwner = file.owner_id === subject.id;
    const viaAdminPath = !isOwner;
    if (viaAdminPath && !subject.permissions.has('file.share.all')) {
      throw new NotFoundException(); // 존재 은닉(§10.2)
    }

    let expiresAt = input.expiresAt ?? null;
    if (viaAdminPath) {
      // 관리자 경로는 만료 필수 — 지정이 없거나 상한을 넘으면 상한으로 조정한다
      const cap = new Date(Date.now() + ADMIN_GRANT_MAX_DAYS * 24 * 60 * 60 * 1000);
      expiresAt = expiresAt && expiresAt < cap ? expiresAt : cap;
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.grants.create(tx, {
        tenantId: subject.tenantId,
        actorId: subject.id,
        subjectId: input.subjectId,
        resourceType: 'file',
        resourceId: fileId,
        permissionCodes: input.permissions,
        expiresAt,
        viaAdminPath,
      });
    });
    return this.list(subject, fileId);
  }

  /** 특정 파일의 공유 목록 — 소유자·생성자·관리자만 볼 수 있다 */
  async list(subject: SubjectSnapshot, fileId: string): Promise<ShareSummary[]> {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.deleted_at) throw new NotFoundException();
    if (file.owner_id !== subject.id && !subject.permissions.has('file.share.all')) {
      throw new NotFoundException();
    }
    // Grant 조회는 전용 통로(GrantStore)를 경유한다 — G-2 룰을 느슨하게 하지 않기 위해
    const rows = await this.grantStore.findByResource('file', fileId);
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
   * FILE-5 공유 회수 — 관계형 2차 인가(§7.3).
   * 게이트 Permission 은 컨트롤러가 선언하고, **관계 조건은 `PolicyService.canRevokeShare` 가 판정**한다.
   * 핸들러에 임의 구현을 두지 않는 이유는 감사·시뮬레이터가 같은 로직을 재사용해야 하기 때문이다.
   */
  async revoke(subject: SubjectSnapshot, fileId: string, grantId: string): Promise<void> {
    const grant = await this.grantStore.findById(grantId);
    if (!grant || grant.resource_id !== fileId) throw new NotFoundException();
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.deleted_at) throw new NotFoundException();

    const decision = this.policy.canRevokeShare(subject, {
      resourceType: 'file',
      ownerId: file.owner_id,
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
