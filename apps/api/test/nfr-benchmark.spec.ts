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
import { ResourceLoaderRegistry } from '../src/authorization/resource-loader';

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
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domain.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
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

  /**
   * WP-15 DoD — **리소스형 API 의 p95 측정치 기록**(WT-28).
   *
   * 리소스형 요청은 캐시가 적중해도 **DB 왕복이 최소 3회**다: pv 대조 → 리소스 로드 →
   * Grant 조회. 권한 평가 자체만 재는 기존 측정으로는 이 비용이 드러나지 않아,
   * Phase 2 의 주력 API 가 목표를 지키는지 아무도 모르는 상태였다.
   */
  it('리소스형 API 대표 3종의 p95 를 측정해 기록한다 (WP-15 DoD)', async () => {
    const owner = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `perf-${uid()}@t.local`, password_hash: 'x',
        name: '성능', status: 'ACTIVE',
      },
    });
    const file = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: owner.id, name: `perf-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });
    const domain = await prisma.domain.create({
      data: {
        tenant_id: TENANT, owner_id: owner.id,
        fqdn: `perf-${uid()}.example.com`, status: 'UNVERIFIED',
      },
    });
    const loader = new ResourceLoaderRegistry(p);

    /** 실제 요청 경로를 재현한다: 스냅샷 조회 → 리소스 로드 → 평가 */
    const measure = async (label: string, run: () => Promise<unknown>): Promise<number> => {
      for (let i = 0; i < 20; i += 1) await run(); // 워밍업
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const t0 = process.hrtime.bigint();
        await run();
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      const p95 = percentile(samples, 95);
      console.log(`${label} p95: ${p95.toFixed(2)}ms (표본 ${SAMPLES})`);
      return p95;
    };

    const results: Record<string, number> = {};
    results['GET /files/:id'] = await measure('GET /files/:id', async () => {
      const subject = await snapshots.forUser(owner.id);
      const ref = await loader.load('file', file.id);
      await authz.can(subject!, 'file.read', ref);
    });
    results['PATCH /files/:id'] = await measure('PATCH /files/:id', async () => {
      const subject = await snapshots.forUser(owner.id);
      const ref = await loader.load('file', file.id);
      await authz.can(subject!, 'file.update', ref);
    });
    results['GET /domains/:id'] = await measure('GET /domains/:id', async () => {
      const subject = await snapshots.forUser(owner.id);
      const ref = await loader.load('domain', domain.id);
      await authz.can(subject!, 'domain.read', ref);
    });

    // **목표 미달을 빌드 실패로 삼지 않는다** — 로컬·CI 하드웨어 편차가 크고, 성능 게이트는
    // 전용 벤치 환경에서만 의미가 있다. 여기서는 측정치를 기록해 §11 대비 판단 근거를 남긴다.
    console.log(`[WP-15 성능 기록] ${JSON.stringify(results)}`);
    for (const value of Object.values(results)) expect(value).toBeGreaterThan(0);
  });
});
