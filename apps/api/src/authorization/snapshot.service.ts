import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionScope, SubjectSnapshot } from './types';

/**
 * 주체의 유효 권한 스냅샷을 DB에서 구성한다 (역할 합집합 — §4.5).
 * 만료된 역할(expires_at 경과)은 제외한다.
 * WP-4에서 Redis 캐시(perm:{user_id}, §8.3)가 이 앞단에 놓인다 — 인터페이스는 동일 유지.
 */
@Injectable()
export class SnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  /** 사용자가 없으면 null */
  async forUser(userId: string): Promise<SubjectSnapshot | null> {
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
