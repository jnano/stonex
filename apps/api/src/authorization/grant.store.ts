import { Injectable } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { GrantStore } from './types';

/**
 * resource_grants 조회 (평가기 2·4단계).
 * Grant는 캐시하지 않고 매번 DB 조회한다 — idx_grants_lookup 단일 인덱스 조회이며
 * 공유 회수의 즉시성이 보장된다(§8.3).
 */
@Injectable()
export class PrismaGrantStore implements GrantStore {
  constructor(private readonly prisma: PrismaService) {}

  async findGrants(
    subjectId: string,
    resourceType: string,
    resourceId: string,
    permissionCode: string,
  ): Promise<Array<{ effect: 'ALLOW' | 'DENY'; expiresAt: Date | null }>> {
    const rows = await this.prisma.resourceGrant.findMany({
      where: {
        subject_type: 'USER',
        subject_id: subjectId,
        resource_type: resourceType,
        resource_id: resourceId,
        permission: { code: permissionCode },
      },
      select: { effect: true, expires_at: true },
    });
    return rows.map((r) => ({ effect: r.effect as 'ALLOW' | 'DENY', expiresAt: r.expires_at }));
  }

  /**
   * 주체가 특정 리소스 타입에 대해 보유한 **유효한**(만료 전) Grant 전체.
   *
   * 목록 API(컬렉션 규약 §7.3)가 행 범위를 계산할 때 사용한다. Grant 조회를 이 통로로 모아
   * 두면 G-2(Semgrep)의 "resource_grants 직접 접근 금지" 룰을 느슨하게 하지 않아도 되고,
   * 만료 판정 규칙이 평가기와 한 곳에서 관리된다.
   */
  async findSubjectGrants(
    subjectId: string,
    resourceType: string,
  ): Promise<Array<{ resourceId: string; effect: 'ALLOW' | 'DENY' }>> {
    const now = new Date();
    const rows = await this.prisma.resourceGrant.findMany({
      where: {
        subject_type: 'USER',
        subject_id: subjectId,
        resource_type: resourceType,
        OR: [{ expires_at: null }, { expires_at: { gt: now } }],
      },
      select: { resource_id: true, effect: true },
    });
    return rows.map((r) => ({ resourceId: r.resource_id, effect: r.effect as 'ALLOW' | 'DENY' }));
  }

  /** 특정 리소스에 걸린 Grant 전체 (공유 목록 화면용). 조회 전용 통로 */
  async findByResource(resourceType: string, resourceId: string) {
    return this.prisma.resourceGrant.findMany({
      where: { resource_type: resourceType, resource_id: resourceId },
      include: { permission: true },
      orderBy: { granted_at: 'desc' },
    });
  }

  /** Grant 1건 조회 (회수 전 관계 판정용). 조회 전용 통로 */
  async findById(grantId: string) {
    return this.prisma.resourceGrant.findUnique({ where: { id: grantId } });
  }

  /**
   * 전체 Grant 수 — 순찰의 blast-radius 비율 계산용(WT-11). 조회 전용 통로.
   * 순찰은 트랜잭션 안에서 돌므로 클라이언트를 주입받는다.
   */
  async countAll(tx: Prisma.TransactionClient): Promise<number> {
    return tx.resourceGrant.count();
  }
}
