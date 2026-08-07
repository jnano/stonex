import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionCacheService } from '../cache/permission-cache.service';
import { PermissionScope, SubjectSnapshot } from './types';

/**
 * 주체의 유효 권한 스냅샷 제공 (기획서 §8.2·§8.3).
 *
 * 조회 순서: Redis 캐시 → (미적중·손상·장애 시) DB 재구성 → 캐시 기록.
 * Redis 장애에도 DB 폴백으로 동작이 지속된다(§11 가용성 99.9%).
 * 권위 소스는 DB 의 users.perm_version 이며, 캐시 값의 pv 는 재구성 시점 값이다.
 */
@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PermissionCacheService,
  ) {}

  /**
   * 사용자가 없으면 null. 캐시 적중 시에도 status·pv 가 포함되어 평가기 0단계가 동작한다.
   *
   * **권위 소스는 DB의 perm_version 이므로, 캐시 값은 항상 DB pv 와 대조한 뒤에만 사용한다.**
   * 캐시가 stale 인 채 토큰의 옛 pv 와 우연히 일치하면 회수된 권한이 계속 통과하기 때문이다
   * (캐시 삭제 명령이 유실되는 경우가 정확히 그 상황이다 — §8.3의 백스톱이 성립하려면 이 대조가 필요).
   * 대조 비용은 PK 단일 조회 1회이며, 비싼 부분(역할·권한 조인)은 캐시가 계속 절약한다.
   */
  async forUser(userId: string): Promise<SubjectSnapshot | null> {
    const authoritative = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { perm_version: true },
    });
    if (!authoritative) return null;

    const cached = await this.cache.get(userId);
    if (cached && cached.permVersion === authoritative.perm_version) return cached;

    // 캐시 없음 또는 stale → DB 재구성 후 갱신
    const snapshot = await this.rebuildFromDb(userId);
    if (snapshot) await this.cache.set(snapshot);
    return snapshot;
  }

  /** 캐시를 거치지 않고 DB 에서 직접 재구성 (pv 대조·관리 행위의 대상자 조회에 사용) */
  async rebuildFromDb(userId: string): Promise<SubjectSnapshot | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        user_roles: {
          include: { role: { include: { role_permissions: { include: { permission: true } } } } },
        },
      },
    });
    if (!user) return null;

    const now = Date.now();
    const activeRoles = user.user_roles.filter(
      (ur) => ur.expires_at === null || ur.expires_at.getTime() > now,
    );
    const permissions = new Map<string, PermissionScope>();
    for (const ur of activeRoles) {
      for (const rp of ur.role.role_permissions) {
        permissions.set(rp.permission.code, rp.permission.scope as PermissionScope);
      }
    }
    return {
      id: user.id,
      tenantId: user.tenant_id,
      status: user.status,
      permVersion: user.perm_version,
      roles: activeRoles.map((ur) => ur.role.code),
      permissions,
    };
  }
}
