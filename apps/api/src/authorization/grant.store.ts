import { Injectable } from '@nestjs/common';
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
}
