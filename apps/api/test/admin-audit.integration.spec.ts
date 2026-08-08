/**
 * WP-15 통합 테스트 (실 DB) — ADM-4 감사 조회 · ADM-5 권한 시뮬레이터.
 *
 * DoD:
 *  - **시뮬레이터의 allow·step 이 실제 평가 결과와 일치**한다(교차 검증)
 *  - ADM-4 대표 쿼리 3종의 EXPLAIN 에 Seq Scan 이 없다
 *  - 감사 detail 에 password_hash·totp_secret·verify_token·storage_key 가 **기록 자체가 되지 않는다**
 *  - 기간 필터가 없거나 과도하면 거부된다 (파티션 프루닝 전제)
 *  - 시뮬레이터 질의가 전건 감사에 남는다
 *  - 비UUID·미등록 타입이 404 로 정규화된다
 */
import { testRegistry } from './helpers/registry';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AuditQueryService } from '../src/admin/audit-query.service';
import { PermissionSimulatorService } from '../src/admin/simulator.service';
import { AuthorizationService } from '../src/authorization/authorization.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { ResourceLoaderRegistry } from '../src/authorization/resource-loader';
import { SnapshotService } from '../src/authorization/snapshot.service';
import { PermissionCacheService } from '../src/cache/permission-cache.service';
import { RedisService } from '../src/cache/redis.service';
import { PermissionScope, SubjectSnapshot } from '../src/authorization/types';
import { PERMISSIONS, ROLES } from '../../../db/seeds/permissions';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009982';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('WP-15 ADM-4 감사 조회 · ADM-5 시뮬레이터 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let audits: AuditQueryService;
  let simulator: PermissionSimulatorService;
  let authz: AuthorizationService;
  let loader: ResourceLoaderRegistry;
  let redis: RedisService;
  let adminId: string;
  let memberId: string;
  let otherId: string;
  const permIds: Record<string, string> = {};
  const roleIds: Record<string, string> = {};

  const snapshot = (id: string, perms: Array<[string, PermissionScope]> = []): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', permVersion: 1, roles: [], permissions: new Map(perms),
  });

  const makeUser = async (label: string) =>
    prisma.user.create({
      data: {
        tenant_id: TENANT, email: `${label}-${uid()}@t.local`, password_hash: 'x',
        name: label, status: 'ACTIVE',
      },
    });

  const makeFile = async (owner: string) =>
    prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: owner, name: `f-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;

    const audit = new AuditService();
    const store = new PrismaGrantStore(p);
    redis = new RedisService();
    authz = new AuthorizationService(store, testRegistry(p));
    loader = new ResourceLoaderRegistry(testRegistry(p));
    audits = new AuditQueryService(p);
    simulator = new PermissionSimulatorService(
      p, authz, new SnapshotService(p, new PermissionCacheService(redis)), loader, audit,
    );

    await prisma.tenant.upsert({
      where: { id: TENANT }, update: {}, create: { id: TENANT, name: `t-${uid()}` },
    });
    for (const def of PERMISSIONS) {
      const row = await prisma.permission.upsert({
        where: { code: def.code }, update: {},
        create: { code: def.code, description: def.description, scope: def.scope, module: def.module },
      });
      permIds[def.code] = row.id;
    }
    for (const r of ROLES) {
      const role = await prisma.role.upsert({
        where: { tenant_id_code: { tenant_id: TENANT, code: r.code } },
        update: {},
        create: {
          tenant_id: TENANT, code: r.code, name: r.name,
          display_order: r.displayOrder, requires_2fa: r.requires2fa, is_system: r.isSystem,
        },
      });
      roleIds[r.code] = role.id;
      // MEMBER 역할에 시드 매핑을 실제로 넣어야 시뮬레이터가 의미 있는 결과를 낸다
      if (r.code === 'MEMBER') {
        for (const code of r.permissions) {
          await prisma.rolePermission.upsert({
            where: { role_id_permission_id: { role_id: role.id, permission_id: permIds[code] } },
            update: {},
            create: { tenant_id: TENANT, role_id: role.id, permission_id: permIds[code] },
          });
        }
      }
    }

    adminId = (await makeUser('admin')).id;
    memberId = (await makeUser('member')).id;
    otherId = (await makeUser('other')).id;
    await prisma.userRole.create({
      data: { tenant_id: TENANT, user_id: memberId, role_id: roleIds['MEMBER'] },
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.rolePermission.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await redis.onModuleDestroy();
    await prisma.$disconnect();
  });

  // ── ADM-4 ────────────────────────────────────────────────────
  describe('ADM-4 감사 로그 조회', () => {
    const range = () => ({
      from: new Date(Date.now() - 60 * 60 * 1000),
      to: new Date(Date.now() + 60 * 60 * 1000),
    });

    it('행위자·행위 유형·대상으로 필터링된다', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit.audit_logs (tenant_id, actor_id, action, target_type, target_id, detail)
         VALUES ($1::uuid, $2::uuid, 'role.grant', 'user', $3::uuid, '{"n":1}'::jsonb)`,
        TENANT, adminId, memberId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit.audit_logs (tenant_id, actor_id, action, detail)
         VALUES ($1::uuid, $2::uuid, 'file.upload', '{}'::jsonb)`,
        TENANT, memberId,
      );

      const byActor = await audits.search(TENANT, { ...range(), actorId: adminId });
      expect(byActor.items.every((i) => i.actorId === adminId)).toBe(true);
      expect(byActor.total).toBeGreaterThanOrEqual(1);

      const byAction = await audits.search(TENANT, { ...range(), action: 'file.upload' });
      expect(byAction.items.every((i) => i.action === 'file.upload')).toBe(true);

      const byTarget = await audits.search(TENANT, { ...range(), targetType: 'user', targetId: memberId });
      expect(byTarget.total).toBeGreaterThanOrEqual(1);
    });

    it('기간 필터가 없거나 과도하면 거부된다 (파티션 프루닝 전제)', async () => {
      await expect(
        audits.search(TENANT, { from: new Date('nope'), to: new Date() }),
      ).rejects.toMatchObject({ status: 400 });

      // 종료가 시작보다 앞이면 거부
      await expect(
        audits.search(TENANT, { from: new Date(), to: new Date(Date.now() - 1000) }),
      ).rejects.toMatchObject({ status: 400 });

      // 상한(기본 92일)을 넘는 창은 거부 — 전 구간 스캔이 되면 감사 INSERT 가 밀리고
      // INV-6 에 의해 모든 권한 변경이 롤백된다
      await expect(
        audits.search(TENANT, {
          from: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000), to: new Date(),
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('대표 쿼리 3종의 EXPLAIN 에 Seq Scan 이 없다', async () => {
      const plans = await Promise.all([
        audits.explain(TENANT, range()),
        audits.explain(TENANT, { ...range(), actorId: adminId }),
        audits.explain(TENANT, { ...range(), action: 'role.grant' }),
      ]);
      for (const plan of plans) {
        // 파티션 프루닝만으로는 파티션 **내부** 스캔이 남는다 — 인덱스가 실제로 쓰이는지 본다
        expect(plan).not.toMatch(/Seq Scan/);
      }
    });

    it('반환 시각이 실제 기록 시각과 일치한다 (timestamptz 시간대 함정 회귀 방지)', async () => {
      // `@prisma/adapter-pg` 의 raw 경로는 timestamptz 를 **세션 시간대의 벽시계로** 주고받는다.
      // Date 객체를 그대로 쓰면 DB 세션이 Asia/Seoul 일 때 9시간 어긋나 **범위 필터가 조용히
      // 0건을 반환**한다(실측 확인). 여기서 굳혀 두지 않으면 같은 함정에 다시 빠진다.
      const before = Date.now();
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit.audit_logs (tenant_id, actor_id, action, detail)
         VALUES ($1::uuid, $2::uuid, 'tz.probe', '{}'::jsonb)`,
        TENANT, adminId,
      );
      const after = Date.now();

      const found = await audits.search(TENANT, { ...range(), action: 'tz.probe' });
      expect(found.total).toBe(1);

      const at = new Date(found.items[0].at).getTime();
      // 오차 허용은 1초 — 9시간 어긋나면 즉시 걸린다
      expect(at).toBeGreaterThanOrEqual(before - 1000);
      expect(at).toBeLessThanOrEqual(after + 1000);
    });

    it('비UUID 필터는 400 으로 정규화된다', async () => {
      await expect(
        audits.search(TENANT, { ...range(), actorId: 'not-a-uuid' }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  // ── 감사 마스킹 (WT-26) ──────────────────────────────────────
  it('감사 detail 에 비밀 키는 기록 자체가 되지 않는다 (마스킹이 아니라 배제)', async () => {
    const audit = new AuditService();
    await prisma.$transaction(async (tx) => {
      await audit.record(tx, {
        tenantId: TENANT, actorId: adminId, action: 'test.masking',
        targetType: 'user', targetId: memberId,
        detail: {
          before: { password_hash: '$argon2id$secret', totp_secret: 'JBSWY3DP' },
          after: {
            name: '정상 필드',
            nested: { storage_key: `${TENANT}/leak`, verify_token: 'tok', keep: 'ok' },
            list: [{ secret: 'x', fine: 1 }],
          },
        },
      });
    });

    const [row] = await prisma.$queryRaw<Array<{ detail: Record<string, unknown> }>>`
      SELECT detail FROM audit.audit_logs
       WHERE tenant_id = ${TENANT}::uuid AND action = 'test.masking'`;
    const serialized = JSON.stringify(row.detail);

    for (const forbidden of ['password_hash', 'totp_secret', 'verify_token', 'storage_key', 'secret']) {
      expect(serialized).not.toContain(forbidden);
    }
    // 값까지 사라졌는지 확인 — 키만 지우고 값이 남는 구현이면 여기서 걸린다
    expect(serialized).not.toContain('JBSWY3DP');
    expect(serialized).not.toContain('argon2id');
    // 정상 필드는 그대로 남는다
    expect(serialized).toContain('정상 필드');
    expect(serialized).toContain('"keep":"ok"');
    expect(serialized).toContain('"fine":1');
  });

  // ── ADM-5 ────────────────────────────────────────────────────
  describe('ADM-5 권한 시뮬레이터', () => {
    const actor = () => snapshot(adminId, [['admin.role.read', 'global']]);

    it('allow·step 이 실제 평가 결과와 일치한다 (교차 검증)', async () => {
      const ownFile = await makeFile(memberId);
      const othersFile = await makeFile(otherId);
      await prisma.resourceGrant.create({
        data: {
          tenant_id: TENANT, subject_id: memberId, resource_type: 'file', resource_id: othersFile.id,
          permission_id: permIds['file.read'], effect: 'ALLOW', granted_by: otherId,
        },
      });

      const cases = [
        { permission: 'file.read', resourceId: ownFile.id, label: '소유' },
        { permission: 'file.read', resourceId: othersFile.id, label: 'Grant 수령' },
        { permission: 'file.delete', resourceId: othersFile.id, label: '타인 파일 삭제' },
        { permission: 'admin.role.manage', resourceId: undefined, label: '미보유 전역 권한' },
      ];

      for (const c of cases) {
        const sim = await simulator.simulate(actor(), {
          subjectId: memberId,
          permission: c.permission,
          ...(c.resourceId ? { resourceType: 'file', resourceId: c.resourceId } : {}),
        });

        // 평가기를 직접 호출한 결과와 대조한다 — 시뮬레이터가 별도 로직을 쓰면 여기서 갈린다
        const target = await new SnapshotService(p, new PermissionCacheService(redis))
          .rebuildFromDb(memberId);
        const ref = c.resourceId ? await loader.load('file', c.resourceId) : undefined;
        const real = await authz.can(target!, c.permission, ref);

        expect({ label: c.label, allow: sim.allow, step: sim.step })
          .toEqual({ label: c.label, allow: real.allow, step: real.step });
        expect(sim.reason).toBe(real.code);
      }
    });

    it('응답 사유는 열거형뿐이고 평가기의 자유 텍스트가 새지 않는다 (WT-13)', async () => {
      const file = await makeFile(memberId);
      const sim = await simulator.simulate(actor(), {
        subjectId: memberId, permission: 'file.read', resourceType: 'file', resourceId: file.id,
      });
      expect([
        'SUBJECT_NOT_ACTIVE', 'RESOURCE_STATE', 'EXPLICIT_DENY',
        'ROLE_GLOBAL', 'ROLE_OWNED', 'GRANT', 'DEFAULT_DENY',
      ]).toContain(sim.reason);
      // 응답 어디에도 내부 설명 문구가 없어야 한다
      expect(JSON.stringify(sim)).not.toContain('역할 보유');
      expect(JSON.stringify(sim)).not.toContain('default deny');
    });

    it('질의가 전건 감사에 남는다 (§14.4 — 감시자도 감사 대상)', async () => {
      const file = await makeFile(memberId);
      await simulator.simulate(actor(), {
        subjectId: memberId, permission: 'file.update', resourceType: 'file', resourceId: file.id,
      });

      const [log] = await prisma.$queryRaw<Array<{ detail: { after: Record<string, unknown> } }>>`
        SELECT detail FROM audit.audit_logs
         WHERE tenant_id = ${TENANT}::uuid AND action = 'admin.simulate'
         ORDER BY created_at DESC LIMIT 1`;
      // {method, path} 만 남기면 무엇을 조회했는지 알 수 없다 — 질의 내용이 있어야 한다
      expect(log.detail.after).toMatchObject({
        permission: 'file.update', resourceType: 'file', resourceId: file.id,
      });
    });

    it('비UUID·미등록 리소스 타입은 404 로 정규화된다 (응답 형상이 오라클이 되지 않도록)', async () => {
      await expect(
        simulator.simulate(actor(), { subjectId: 'not-a-uuid', permission: 'file.read' }),
      ).rejects.toMatchObject({ status: 404 });

      const file = await makeFile(memberId);
      await expect(
        simulator.simulate(actor(), {
          subjectId: memberId, permission: 'file.read',
          resourceType: 'board.post', resourceId: file.id,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('우위 검사를 적용하지 않는다 — 상위 관리자에 대한 질의도 답한다 (§4.6-3)', async () => {
      const superAdmin = await makeUser('super');
      await prisma.userRole.create({
        data: { tenant_id: TENANT, user_id: superAdmin.id, role_id: roleIds['SUPER_ADMIN'] },
      });
      // 제압할 수 없는 대상을 못 보게 하면 "왜 이 사람을 관리할 수 없는가"를 설명할 수 없다
      const sim = await simulator.simulate(actor(), {
        subjectId: superAdmin.id, permission: 'admin.role.manage',
      });
      expect(sim.subjectId).toBe(superAdmin.id);
      expect(typeof sim.allow).toBe('boolean');
    });
  });
});
