import { Injectable } from '@nestjs/common';
import { PermissionScope, SubjectSnapshot } from '../authorization/types';
import { RedisService } from './redis.service';

export const SNAPSHOT_TTL_SECONDS = 300; // §8.3
const KEY_PREFIX = 'perm:';

/** Redis 에 저장되는 직렬화 형태 (§8.3의 값 구조) */
interface StoredSnapshot {
  pv: number;
  status: string;
  tenantId: string;
  roles: string[];
  permissions: Array<{ code: string; scope: PermissionScope }>;
}

/**
 * 권한 스냅샷 캐시 (기획서 §8.3).
 *
 * 키 `perm:{user_id}`, TTL 300초. 값에 pv·status 를 포함해
 *  - 평가기 0단계(주체 상태 검사)가 캐시 적중 시에도 동작하고,
 *  - stale write 가 발생해도 pv 불일치로 감지된다.
 * 권위 소스는 항상 DB 의 users.perm_version 이다.
 */
@Injectable()
export class PermissionCacheService {
  constructor(private readonly redis: RedisService) {}

  private key(userId: string): string {
    return `${KEY_PREFIX}${userId}`;
  }

  async get(userId: string): Promise<SubjectSnapshot | null> {
    const raw = await this.redis.get(this.key(userId));
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as StoredSnapshot;
      return {
        id: userId,
        tenantId: stored.tenantId,
        status: stored.status,
        permVersion: stored.pv,
        roles: stored.roles,
        permissions: new Map(stored.permissions.map((p) => [p.code, p.scope])),
      };
    } catch {
      return null; // 손상된 값은 미적중 취급
    }
  }

  async set(snapshot: SubjectSnapshot): Promise<void> {
    const stored: StoredSnapshot = {
      pv: snapshot.permVersion, // 재구성 시점에 읽은 pv 를 값에 포함(§8.3)
      status: snapshot.status,
      tenantId: snapshot.tenantId,
      roles: snapshot.roles,
      permissions: [...snapshot.permissions].map(([code, scope]) => ({ code, scope })),
    };
    await this.redis.setEx(this.key(snapshot.id), SNAPSHOT_TTL_SECONDS, JSON.stringify(stored));
  }

  async invalidate(userIds: string[]): Promise<void> {
    await this.redis.del(...userIds.map((id) => this.key(id)));
  }
}
