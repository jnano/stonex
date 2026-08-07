/**
 * 비기능 요구사항 측정 (기획서 §11) — WP-8 DoD "측정치 기록".
 *
 * 목표: 권한 평가 p95 < 5ms(캐시 적중) / < 30ms(미적중), 권한 회수 전파 10초 이내.
 * 로컬·CI 하드웨어 편차가 크므로 **목표 미달을 빌드 실패로 삼지 않고**, 측정치를 출력해 기록한다.
 * (성능 회귀를 게이트로 만들려면 전용 벤치 환경이 필요하다 — 지금 하면 오탐만 늘어난다)
 * 다만 "회수 전파" 는 기능 요구에 가까우므로 상한(10초)을 실제로 검증한다.
 */
import { PrismaClient } from '@stonex/db';
import { AuthorizationService } from '../src/authorization/authorization.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { SnapshotService } from '../src/authorization/snapshot.service';
import { PermissionCacheService } from '../src/cache/permission-cache.service';
import { PermVersionService } from '../src/cache/perm-version.service';
import { RedisService } from '../src/cache/redis.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';
import { JwtTokenVerifier } from '../src/auth/jwt-token-verifier';
import { AuthGuard } from '../src/authorization/guards/auth.guard';
import { createPrisma, uid } from './support/test-app';
import { seedRolesForTenant } from './support/matrix-fixture';

jest.setTimeout(180_000);

const TENANT = '00000000-0000-0000-0000-000000009991';
const SAMPLES = 200;

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

describe('비기능 측정 (§11)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let redis: RedisService;
  let cache: PermissionCacheService;
  let snapshots: SnapshotService;
  let authz: AuthorizationService;
  let permVersion: PermVersionService;
  let userId: string;

  beforeAll(async () => {
    prisma = createPrisma();
    p = prisma as unknown as PrismaService;
    redis = new RedisService();
    cache = new PermissionCacheService(redis);
    permVersion = new PermVersionService(p, cache);
    snapshots = new SnapshotService(p, cache);
    authz = new AuthorizationService(new PrismaGrantStore(p));

    const roleIds = await seedRolesForTenant(prisma, TENANT);
    const user = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `nfr-${uid()}@t.local`, password_hash: 'x',
        name: 'nfr', status: 'ACTIVE',
      },
    });
    await prisma.userRole.create({
      data: { tenant_id: TENANT, user_id: user.id, role_id: roleIds['OPERATOR'] },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.rolePermission.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  });

  it('권한 평가 지연을 측정해 기록한다 (목표: 적중 p95<5ms, 미적중 p95<30ms)', async () => {
    // 캐시 적중 경로
    await snapshots.forUser(userId);
    const hit: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const start = performance.now();
      const snapshot = await snapshots.forUser(userId);
      await authz.can(snapshot!, 'member.read');
      hit.push(performance.now() - start);
    }

    // 미적중 경로 (매번 캐시 삭제 후 재구성)
    const miss: number[] = [];
    for (let i = 0; i < 50; i++) {
      await cache.invalidate([userId]);
      const start = performance.now();
      const snapshot = await snapshots.forUser(userId);
      await authz.can(snapshot!, 'member.read');
      miss.push(performance.now() - start);
    }

    const report = {
      '캐시 적중 p50': `${percentile(hit, 50).toFixed(2)}ms`,
      '캐시 적중 p95': `${percentile(hit, 95).toFixed(2)}ms (목표 <5ms)`,
      '캐시 미적중 p50': `${percentile(miss, 50).toFixed(2)}ms`,
      '캐시 미적중 p95': `${percentile(miss, 95).toFixed(2)}ms (목표 <30ms)`,
    };
    console.log('권한 평가 지연 측정:', JSON.stringify(report, null, 2));

    // 측정이 실제로 수행됐는지만 확인한다(임계값은 기록 대상, 게이트 아님)
    expect(hit).toHaveLength(SAMPLES);
    expect(percentile(hit, 95)).toBeGreaterThan(0);
  });

  it('권한 회수가 10초 이내에 전파된다 (§11)', async () => {
    const tokens = new TokenService();
    const snapshot = await snapshots.forUser(userId);
    const token = await tokens.signAccess({
      sub: userId, tenant: TENANT, pv: snapshot!.permVersion,
    });
    const guard = new AuthGuard(
      { getAllAndOverride: () => undefined } as never,
      snapshots,
      new JwtTokenVerifier(tokens),
    );
    const context = (auth: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: auth } }) }),
        getHandler: () => undefined,
        getClass: () => undefined,
      }) as never;

    await expect(guard.canActivate(context(`Bearer ${token}`))).resolves.toBe(true);

    const start = Date.now();
    await permVersion.bumpAndFlush([userId]); // 권한 회수에 해당하는 무효화
    await expect(guard.canActivate(context(`Bearer ${token}`))).rejects.toThrow();
    const elapsedMs = Date.now() - start;

    console.log(`권한 회수 전파: ${elapsedMs}ms (목표 10,000ms 이내)`);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
