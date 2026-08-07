/**
 * WP-4 통합 테스트 (실 DB + 실 Redis).
 * DoD:
 *  - 역할 회수 → 기존 Access Token 즉시 거부 (pv 불일치, §8.3 / §11 전파 10초 이내)
 *  - 역할-권한 매핑 변경 → 보유자 전원 스냅샷 무효화
 *  - Redis 장애 상태에서도 DB 폴백으로 요청 처리 지속 (§11 가용성)
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/cache/redis.service';
import { PermissionCacheService, SNAPSHOT_TTL_SECONDS } from '../src/cache/permission-cache.service';
import { PermVersionService } from '../src/cache/perm-version.service';
import { SnapshotService } from '../src/authorization/snapshot.service';
import { AuthGuard } from '../src/authorization/guards/auth.guard';
import { JwtTokenVerifier } from '../src/auth/jwt-token-verifier';
import { TokenService } from '../src/auth/token.service';

jest.setTimeout(90_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 테스트는 실제 DB를 요구).');
process.env.JWT_SECRET ??= 'test-secret-value-at-least-32-characters-long';

const TENANT = '00000000-0000-0000-0000-000000009996';

/** AuthGuard 를 HTTP 없이 구동하기 위한 최소 ExecutionContext */
const contextFor = (authorization: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as never;

const reflectorStub = { getAllAndOverride: () => undefined } as never;

describe('WP-4 권한 스냅샷 캐시 (실 DB + Redis)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let redis: RedisService;
  let cache: PermissionCacheService;
  let permVersion: PermVersionService;
  let snapshots: SnapshotService;
  let tokens: TokenService;
  let userId: string;
  let roleId: string;
  let readPermId: string;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    redis = new RedisService();
    cache = new PermissionCacheService(redis);
    permVersion = new PermVersionService(p, cache);
    snapshots = new SnapshotService(p, cache);
    tokens = new TokenService();

    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'cache-test' } });
    const user = await prisma.user.create({
      data: { tenant_id: TENANT, email: `cache-${Date.now()}@t.local`, password_hash: 'x', name: '캐시', status: 'ACTIVE' },
    });
    const role = await prisma.role.create({
      data: { tenant_id: TENANT, code: `CACHE_T_${Date.now()}`, name: '캐시테스트역할' },
    });
    const perm = await prisma.permission.upsert({
      where: { code: 'member.read' }, update: {},
      create: { code: 'member.read', description: '회원 조회', scope: 'global' },
    });
    await prisma.rolePermission.create({
      data: { tenant_id: TENANT, role_id: role.id, permission_id: perm.id },
    });
    await prisma.userRole.create({ data: { tenant_id: TENANT, user_id: user.id, role_id: role.id } });
    userId = user.id; roleId = role.id; readPermId = perm.id;
  });

  afterAll(async () => {
    await cache.invalidate([userId]);
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.rolePermission.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  });

  it('캐시 미적중 시 DB 재구성 후 기록되고, 재조회는 캐시에서 반환된다', async () => {
    await cache.invalidate([userId]);
    expect(await cache.get(userId)).toBeNull();

    const first = await snapshots.forUser(userId);
    expect(first?.permissions.has('member.read')).toBe(true);

    const cached = await cache.get(userId);
    expect(cached).not.toBeNull();
    expect(cached?.status).toBe('ACTIVE'); // 0단계 상태 검사가 캐시 적중 시에도 가능(§8.3)
    expect(cached?.permVersion).toBe(first?.permVersion);
  });

  it('역할 회수 → 기존 Access Token 이 pv 불일치로 즉시 거부된다 (§8.3)', async () => {
    const before = await snapshots.forUser(userId);
    const accessToken = await tokens.signAccess({
      sub: userId, tenant: TENANT, pv: before?.permVersion ?? 0,
    });
    const guard = new AuthGuard(reflectorStub, snapshots, new JwtTokenVerifier(tokens));
    await expect(guard.canActivate(contextFor(`Bearer ${accessToken}`))).resolves.toBe(true);

    // 권한 회수 — (1) pv 증가 커밋 → (2) 캐시 삭제 순서를 공통 함수가 강제한다
    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { user_id: userId, role_id: roleId } });
      await permVersion.bumpInTx(tx, [userId]);
    });
    await permVersion.flushCache([userId]);

    await expect(guard.canActivate(contextFor(`Bearer ${accessToken}`))).rejects.toThrow();

    // 원복 (이후 테스트를 위해)
    await prisma.userRole.create({ data: { tenant_id: TENANT, user_id: userId, role_id: roleId } });
    await permVersion.bumpAndFlush([userId]);
  });

  it('캐시 삭제가 유실되어도(stale) pv 백스톱이 구권한 사용을 차단한다', async () => {
    const snapshot = await snapshots.forUser(userId); // 캐시 적재
    const staleToken = await tokens.signAccess({
      sub: userId, tenant: TENANT, pv: snapshot?.permVersion ?? 0,
    });
    expect(await cache.get(userId)).not.toBeNull();

    // 캐시 삭제 없이 pv 만 증가 = "Redis del 명령 유실" 재현.
    // 캐시에는 옛 pv 가 남아 토큰과 일치하지만, DB pv 대조가 이를 잡아야 한다.
    await prisma.user.update({ where: { id: userId }, data: { perm_version: { increment: 1 } } });
    const staleCached = await cache.get(userId);
    expect(staleCached?.permVersion).toBe(snapshot?.permVersion); // 캐시는 여전히 옛 값

    const guard = new AuthGuard(reflectorStub, snapshots, new JwtTokenVerifier(tokens));
    await expect(guard.canActivate(contextFor(`Bearer ${staleToken}`))).rejects.toThrow();

    // 대조 과정에서 캐시가 최신 pv 로 갱신되었는지 확인 (자가 치유)
    expect((await cache.get(userId))?.permVersion).not.toBe(snapshot?.permVersion);
    await permVersion.flushCache([userId]);
  });

  it('역할-권한 매핑 변경 → 보유자 전원의 pv 증가 + 캐시 삭제', async () => {
    await snapshots.forUser(userId); // 캐시 적재
    expect(await cache.get(userId)).not.toBeNull();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    await prisma.rolePermission.deleteMany({ where: { role_id: roleId, permission_id: readPermId } });
    const affected = await permVersion.invalidateRoleHolders(roleId);

    expect(affected).toContain(userId);
    expect(await cache.get(userId)).toBeNull(); // 캐시 삭제됨
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.perm_version).toBe(before.perm_version + 1); // pv 백스톱 동반

    const rebuilt = await snapshots.forUser(userId);
    expect(rebuilt?.permissions.has('member.read')).toBe(false); // 변경 반영
  });

  it('Redis 장애 상태에서도 DB 폴백으로 스냅샷을 제공한다 (§11 가용성)', async () => {
    // 접속 불가 포트로 향하는 Redis 클라이언트 = 장애 상황 재현
    const original = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:6399';
    const brokenRedis = new RedisService();
    const brokenCache = new PermissionCacheService(brokenRedis);
    const fallbackSnapshots = new SnapshotService(p, brokenCache);

    try {
      const snapshot = await fallbackSnapshots.forUser(userId);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.status).toBe('ACTIVE'); // 캐시 없이도 평가에 필요한 정보가 모두 있다

      const guard = new AuthGuard(reflectorStub, fallbackSnapshots, new JwtTokenVerifier(tokens));
      const token = await tokens.signAccess({ sub: userId, tenant: TENANT, pv: snapshot?.permVersion ?? 0 });
      await expect(guard.canActivate(contextFor(`Bearer ${token}`))).resolves.toBe(true);
    } finally {
      await brokenRedis.onModuleDestroy();
      process.env.REDIS_URL = original;
    }
  });

  it('스냅샷 TTL 은 기획서 §8.3 의 300초다', () => {
    expect(SNAPSHOT_TTL_SECONDS).toBe(300);
  });
});
