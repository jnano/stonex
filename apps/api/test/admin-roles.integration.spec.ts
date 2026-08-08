/**
 * WP-7 통합 테스트 (실 DB + Redis) — ADM-1~3.
 * DoD:
 *  - is_system 역할 보호 / 보유자 존재 시 삭제 거부 / 미보유 Permission 부여 거부
 *  - 매핑 편집 → 보유자 권한이 수 초 내 반영 (pv 증가 + 캐시 삭제)
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { GovernanceFreezeService } from '../src/governance/freeze.service';
import { AuditService } from '../src/audit/audit.service';
import { PermVersionService } from '../src/cache/perm-version.service';
import { PermissionCacheService } from '../src/cache/permission-cache.service';
import { RedisService } from '../src/cache/redis.service';
import { SnapshotService } from '../src/authorization/snapshot.service';
import { RolesService } from '../src/admin/roles.service';
import { SubjectSnapshot } from '../src/authorization/types';

jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 테스트는 실제 DB를 요구).');

const TENANT = '00000000-0000-0000-0000-000000009994';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('WP-7 관리자 콘솔 ADM-1~3 (실 DB)', () => {
  let prisma: PrismaClient;
  let roles: RolesService;
  let snapshots: SnapshotService;
  let cache: PermissionCacheService;
  let redis: RedisService;
  let superAdmin: SubjectSnapshot;
  let operator: SubjectSnapshot;
  let systemRoleId: string;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    const p = prisma as unknown as PrismaService;
    redis = new RedisService();
    cache = new PermissionCacheService(redis);
    const permVersion = new PermVersionService(p, cache);
    snapshots = new SnapshotService(p, cache);
    roles = new RolesService(p, new AuditService(), permVersion, new GovernanceFreezeService(p, new AuditService()));

    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'roles-test' } });

    const codes: Array<[string, 'global' | 'owned']> = [
      ['admin.role.read', 'global'], ['admin.role.manage', 'global'],
      ['member.read', 'global'], ['system.settings.manage', 'global'],
    ];
    const perms: Record<string, string> = {};
    for (const [code, scope] of codes) {
      const perm = await prisma.permission.upsert({
        where: { code }, update: {}, create: { code, description: code, scope },
      });
      perms[code] = perm.id;
    }

    const mkRole = async (code: string, permCodes: string[], isSystem = false) => {
      const role = await prisma.role.upsert({
        where: { tenant_id_code: { tenant_id: TENANT, code } },
        update: {}, create: { tenant_id: TENANT, code, name: code, is_system: isSystem },
      });
      for (const c of permCodes) {
        await prisma.rolePermission.upsert({
          where: { role_id_permission_id: { role_id: role.id, permission_id: perms[c] } },
          update: {}, create: { tenant_id: TENANT, role_id: role.id, permission_id: perms[c] },
        });
      }
      return role.id;
    };
    const superRoleId = await mkRole('SUPER_ADMIN', codes.map(([c]) => c), true);
    const opRoleId = await mkRole('OPERATOR', ['admin.role.read', 'admin.role.manage', 'member.read']);
    systemRoleId = superRoleId;

    const mkUser = async (roleId: string) => {
      const u = await prisma.user.create({
        data: { tenant_id: TENANT, email: `r-${uid()}@t.local`, password_hash: 'x', name: 'u', status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenant_id: TENANT, user_id: u.id, role_id: roleId } });
      return (await snapshots.rebuildFromDb(u.id)) as SubjectSnapshot;
    };
    superAdmin = await mkUser(superRoleId);
    operator = await mkUser(opRoleId);
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.rolePermission.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  });

  it('ADM-1: 목록에 보유자 수·시스템 여부가 함께 나온다', async () => {
    const list = await roles.list(TENANT);
    const superRole = list.find((r) => r.code === 'SUPER_ADMIN');
    expect(superRole?.isSystem).toBe(true);
    expect(superRole?.holderCount).toBeGreaterThanOrEqual(1);
  });

  it('ADM-2: is_system 역할은 삭제할 수 없다 (§10.3)', async () => {
    await expect(roles.remove(superAdmin, systemRoleId)).rejects.toThrow(/시스템 역할/);
  });

  it('ADM-2: 보유자가 있는 역할은 삭제할 수 없다 (선 회수 후 삭제)', async () => {
    const created = await roles.create(superAdmin, { code: `TMP_${uid()}`, name: '임시' });
    const user = await prisma.user.create({
      data: { tenant_id: TENANT, email: `h-${uid()}@t.local`, password_hash: 'x', name: 'h', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenant_id: TENANT, user_id: user.id, role_id: created.id } });

    await expect(roles.remove(superAdmin, created.id)).rejects.toThrow(/보유자/);

    await prisma.userRole.deleteMany({ where: { role_id: created.id } });
    await expect(roles.remove(superAdmin, created.id)).resolves.toBeUndefined(); // 회수 후에는 가능
  });

  it('ADM-3: 자신이 보유하지 않은 Permission 은 부여할 수 없다 (§10.1)', async () => {
    const target = await roles.create(superAdmin, { code: `T_${uid()}`, name: '대상' });
    // operator 는 system.settings.manage 미보유
    await expect(
      roles.setPermissions(operator, target.id, ['member.read', 'system.settings.manage']),
    ).rejects.toThrow(/보유하지 않은 권한/);

    // 보유분만이면 통과
    const ok = await roles.setPermissions(operator, target.id, ['member.read']);
    expect(ok.permissions.map((p) => p.code)).toEqual(['member.read']);
  });

  it('ADM-3: 매핑에서 제거하는 것은 미보유 권한이어도 허용된다 (약화는 상승이 아니다)', async () => {
    const target = await roles.create(superAdmin, { code: `W_${uid()}`, name: '약화' });
    await roles.setPermissions(superAdmin, target.id, ['member.read', 'system.settings.manage']);

    const weakened = await roles.setPermissions(operator, target.id, ['member.read']);
    expect(weakened.permissions.map((p) => p.code)).toEqual(['member.read']);
  });

  it('ADM-3: 매핑 변경 시 보유자 pv 증가 + 캐시 삭제로 즉시 반영된다 (§8.3)', async () => {
    const role = await roles.create(superAdmin, { code: `M_${uid()}`, name: '매핑' });
    const user = await prisma.user.create({
      data: { tenant_id: TENANT, email: `m-${uid()}@t.local`, password_hash: 'x', name: 'm', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenant_id: TENANT, user_id: user.id, role_id: role.id } });

    await snapshots.forUser(user.id); // 캐시 적재
    expect(await cache.get(user.id)).not.toBeNull();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await roles.setPermissions(superAdmin, role.id, ['member.read']);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.perm_version).toBe(before.perm_version + 1); // pv 백스톱
    expect(await cache.get(user.id)).toBeNull(); // 캐시 삭제

    const rebuilt = await snapshots.forUser(user.id);
    expect(rebuilt?.permissions.has('member.read')).toBe(true); // 변경이 즉시 반영
  });

  it('ADM-2: 역할 복제는 매핑까지 함께 복사한다 (상속 대체 §4.5)', async () => {
    const source = await roles.create(superAdmin, { code: `S_${uid()}`, name: '원본' });
    await roles.setPermissions(superAdmin, source.id, ['member.read', 'admin.role.read']);

    const copy = await roles.duplicate(superAdmin, source.id, `C_${uid()}`, '복제본');
    expect(copy.permissions.map((p) => p.code).sort()).toEqual(['admin.role.read', 'member.read']);
    expect(copy.isSystem).toBe(false);
  });

  it('ADM-2: 역할 변경은 감사 로그에 남는다 (INV-6)', async () => {
    const role = await roles.create(superAdmin, { code: `A_${uid()}`, name: '감사' });
    await roles.update(superAdmin, role.id, { name: '감사(수정)' });

    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs WHERE target_id = ${role.id}::uuid ORDER BY created_at`;
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['role.create', 'role.update']));
  });
});
