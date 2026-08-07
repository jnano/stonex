import { Injectable } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionCacheService } from './permission-cache.service';

/**
 * 권한 무효화의 유일한 통로 (기획서 §8.3).
 *
 * 무효화 순서를 **여기 한 곳에서만** 강제한다:
 *   (1) perm_version 1 증가 (트랜잭션 내, 커밋) → (2) Redis 키 삭제
 * 개별 기능이 이 순서를 직접 다루면 언젠가 어긋난다. 순서가 뒤집히면 삭제 직후
 * 이전 값이 재기록(stale write)될 때 이를 감지할 수단이 사라진다.
 * pv 증가는 Redis 명령이 유실되어도 최대 TTL 동안의 구권한 사용을 막는 백스톱이다.
 *
 * 사용 규약:
 *   await prisma.$transaction(async (tx) => {
 *     ...권한 변경...
 *     await permVersion.bumpInTx(tx, [userId]);   // (1) 커밋 대상
 *   });
 *   await permVersion.flushCache([userId]);        // (2) 커밋 후 캐시 삭제
 * 또는 두 단계를 함께 수행하는 bumpAndFlush() 를 쓴다.
 */
@Injectable()
export class PermVersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PermissionCacheService,
  ) {}

  /** (1) 트랜잭션 내에서 pv 증가. 권한 변경과 같은 트랜잭션으로 커밋되어야 한다 */
  async bumpInTx(tx: Prisma.TransactionClient, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await tx.user.updateMany({
      where: { id: { in: userIds } },
      data: { perm_version: { increment: 1 } },
    });
  }

  /** (2) 커밋 이후 캐시 삭제. 실패해도 pv 불일치가 백스톱으로 동작한다 */
  async flushCache(userIds: string[]): Promise<void> {
    await this.cache.invalidate(userIds);
  }

  /** 트랜잭션 밖에서 단독 무효화가 필요할 때 — (1)→(2) 순서를 보장한다 */
  async bumpAndFlush(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.prisma.user.updateMany({
      where: { id: { in: userIds } },
      data: { perm_version: { increment: 1 } },
    });
    await this.flushCache(userIds);
  }

  /**
   * 역할-권한 매핑 변경 시: 해당 역할 보유자 전원의 pv 를 배치 증가 + 캐시 삭제 (§8.3).
   * 키 삭제만으로는 Redis 명령 유실 시 최대 TTL 동안 구권한이 유지되므로 pv 증가를 반드시 동반한다.
   * 보유자 조회는 idx_user_roles_role 인덱스를 탄다.
   */
  async invalidateRoleHolders(roleId: string): Promise<string[]> {
    const holders = await this.prisma.userRole.findMany({
      where: { role_id: roleId },
      select: { user_id: true },
    });
    const userIds = holders.map((h) => h.user_id);
    await this.bumpAndFlush(userIds);
    return userIds;
  }
}
