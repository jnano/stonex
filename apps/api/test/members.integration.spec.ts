/**
 * WP-5 통합 테스트 (실 DB + Redis).
 * DoD:
 *  - MEM-1~6 (권한별 허용/거부 포함)
 *  - 우위 검사: OPERATOR→SUPER_ADMIN 정지 거부 / 동급 상호 공격 거부 / 본인 대상 거부
 *  - 마지막 활성 SUPER_ADMIN 강등·정지·삭제가 **동시 요청 2건 경쟁 상황에서도** 전부 거부
 *  - 정지 계정의 Access·Refresh 토큰 동시 무효화
 */
import { testRegistry } from './helpers/registry';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { GovernanceFreezeService } from '../src/governance/freeze.service';
import { AuditService } from '../src/audit/audit.service';
import { RoleGrantService } from '../src/authorization/role-grant.service';
import { PermVersionService } from '../src/cache/perm-version.service';
import { PermissionCacheService } from '../src/cache/permission-cache.service';
import { RedisService } from '../src/cache/redis.service';
import { SnapshotService } from '../src/authorization/snapshot.service';
import { SuperAdminGuardService } from '../src/members/super-admin-guard.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { MembersService } from '../src/members/members.service';
import { SubjectSnapshot } from '../src/authorization/types';

jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 테스트는 실제 DB를 요구).');

const TENANT = '00000000-0000-0000-0000-000000009995';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('WP-5 회원 관리 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let members: MembersService;
  let snapshots: SnapshotService;
  let redis: RedisService;
  const roleIds: Record<string, string> = {};

  /** 시드 역할 코드로 사용자 생성 + 스냅샷 반환 */
  const createUser = async (roleCodes: string[], status = 'ACTIVE') => {
    const user = await prisma.user.create({
      data: { tenant_id: TENANT, email: `m-${uid()}@t.local`, password_hash: 'x', name: '테스트', status },
    });
    for (const code of roleCodes) {
      await prisma.userRole.create({
        data: { tenant_id: TENANT, user_id: user.id, role_id: roleIds[code] },
      });
    }
    const snapshot = await snapshots.rebuildFromDb(user.id);
    return { id: user.id, snapshot: snapshot as SubjectSnapshot };
  };

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    redis = new RedisService();
    const cache = new PermissionCacheService(redis);
    const permVersion = new PermVersionService(p, cache);
    const audit = new AuditService();
    const grantService = new ResourceGrantService(audit, new GovernanceFreezeService(p, audit), testRegistry(p));
    snapshots = new SnapshotService(p, cache);
    members = new MembersService(
      p, audit, new RoleGrantService(audit, permVersion, new GovernanceFreezeService(p, audit)), permVersion, snapshots,
      new SuperAdminGuardService(),
      grantService,
    );

    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'members-test' } });

    // 권한·역할 시드 (기획서 §4.4·§4.5의 부분 집합 — 이 테스트에 필요한 만큼)
    const permCodes: Array<[string, 'global' | 'owned']> = [
      ['member.read', 'global'], ['member.update', 'global'], ['member.ban', 'global'],
      ['member.role.assign', 'global'], ['member.delete', 'global'], ['admin.audit.read', 'global'],
      ['file.read', 'owned'], ['system.settings.manage', 'global'],
    ];
    const perms: Record<string, string> = {};
    for (const [code, scope] of permCodes) {
      const perm = await prisma.permission.upsert({
        where: { code }, update: {}, create: { code, description: code, scope },
      });
      perms[code] = perm.id;
    }
    const roleDefs: Array<[string, string[], boolean]> = [
      ['MEMBER', ['file.read'], false],
      ['OPERATOR', ['member.read', 'member.update', 'member.ban', 'member.role.assign', 'member.delete', 'admin.audit.read', 'file.read'], true],
      ['SUPER_ADMIN', permCodes.map(([c]) => c), true],
    ];
    for (const [code, codes, requires2fa] of roleDefs) {
      const role = await prisma.role.upsert({
        where: { tenant_id_code: { tenant_id: TENANT, code } },
        update: {},
        create: { tenant_id: TENANT, code, name: code, requires_2fa: requires2fa },
      });
      roleIds[code] = role.id;
      for (const c of codes) {
        await prisma.rolePermission.upsert({
          where: { role_id_permission_id: { role_id: role.id, permission_id: perms[c] } },
          update: {},
          create: { tenant_id: TENANT, role_id: role.id, permission_id: perms[c] },
        });
      }
    }
  });

  afterAll(async () => {
    await prisma.ownerCleanupJob.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenant_id: TENANT } } });
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.rolePermission.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  });

  it('MEM-2/3: 상세 조회는 내부 필드를 노출하지 않고, 수정은 감사에 남는다', async () => {
    const actor = await createUser(['SUPER_ADMIN']);
    const target = await createUser(['MEMBER']);

    const detail = await members.detail(target.id);
    expect(Object.keys(detail)).toEqual(
      expect.not.arrayContaining(['password_hash', 'totp_secret', 'passwordHash', 'totpSecret']),
    );

    await members.update(actor.snapshot, target.id, { name: '변경된 이름' });
    expect((await members.detail(target.id)).name).toBe('변경된 이름');

    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs WHERE target_id = ${target.id}::uuid AND action = 'member.update'`;
    expect(logs).toHaveLength(1);
  });

  it('우위 검사: OPERATOR 는 SUPER_ADMIN 을 정지할 수 없다', async () => {
    const operator = await createUser(['OPERATOR']);
    const superAdmin = await createUser(['SUPER_ADMIN']);
    await expect(members.setBanned(operator.snapshot, superAdmin.id, true)).rejects.toThrow();
  });

  it('우위 검사: 동급 관리자 상호 공격은 거부된다 (SUPER_ADMIN ↔ SUPER_ADMIN)', async () => {
    const a = await createUser(['SUPER_ADMIN']);
    const b = await createUser(['SUPER_ADMIN']);
    await expect(members.setBanned(a.snapshot, b.id, true)).rejects.toThrow();
    await expect(members.setBanned(b.snapshot, a.id, true)).rejects.toThrow();
  });

  it('우위 검사: 본인 대상 관리 행위는 전면 금지', async () => {
    const actor = await createUser(['SUPER_ADMIN']);
    await expect(members.setBanned(actor.snapshot, actor.id, true)).rejects.toThrow();
    await expect(members.revokeRole(actor.snapshot, actor.id, roleIds['SUPER_ADMIN'])).rejects.toThrow();
  });

  it('MEM-5: 자신이 갖지 못한 권한이 담긴 역할은 부여할 수 없다 (부분집합 검사)', async () => {
    const operator = await createUser(['OPERATOR']); // system.settings.manage 미보유
    const target = await createUser(['MEMBER']);
    await expect(
      members.grantRole(operator.snapshot, target.id, roleIds['SUPER_ADMIN']),
    ).rejects.toThrow();
  });

  it('MEM-5: requires_2fa 역할 부여 시 TOTP 등록 강제 + 기존 refresh 폐기 (RT-4·RT-7)', async () => {
    const actor = await createUser(['SUPER_ADMIN']);
    const target = await createUser(['MEMBER']);
    await prisma.refreshToken.create({
      data: {
        user_id: target.id, token_hash: `h-${uid()}`,
        family_id: crypto.randomUUID(), expires_at: new Date(Date.now() + 86_400_000),
      },
    });

    await members.grantRole(actor.snapshot, target.id, roleIds['OPERATOR']);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.totp_enrollment_required).toBe(true);
    const alive = await prisma.refreshToken.count({ where: { user_id: target.id, revoked_at: null } });
    expect(alive).toBe(0); // 갱신 경로까지 차단
  });

  it('MEM-5: SUPER_ADMIN 에는 만료(expires_at)를 지정할 수 없다 (§4.5)', async () => {
    const actor = await createUser(['SUPER_ADMIN']);
    const target = await createUser(['MEMBER']);
    await expect(
      members.grantRole(actor.snapshot, target.id, roleIds['SUPER_ADMIN'], new Date(Date.now() + 86_400_000)),
    ).rejects.toThrow();
  });

  it('MEM-4: 정지 시 pv 증가 + refresh 전체 폐기로 Access·Refresh 동시 무효화', async () => {
    const actor = await createUser(['SUPER_ADMIN']);
    const target = await createUser(['MEMBER']);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    await prisma.refreshToken.create({
      data: {
        user_id: target.id, token_hash: `h-${uid()}`,
        family_id: crypto.randomUUID(), expires_at: new Date(Date.now() + 86_400_000),
      },
    });

    await members.setBanned(actor.snapshot, target.id, true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.status).toBe('SUSPENDED');
    expect(after.perm_version).toBe(before.perm_version + 1);
    expect(await prisma.refreshToken.count({ where: { user_id: target.id, revoked_at: null } })).toBe(0);
  });

  it('MEM-6: 소프트 삭제 + 세션 폐기 + 해당 사용자 Grant 정리 (§5.3)', async () => {
    const actor = await createUser(['SUPER_ADMIN']);
    const target = await createUser(['MEMBER']);
    const perm = await prisma.permission.findFirstOrThrow({ where: { code: 'file.read' } });
    await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: target.id, resource_type: 'file',
        resource_id: crypto.randomUUID(), permission_id: perm.id, granted_by: actor.id,
      },
    });

    await members.softDelete(actor.snapshot, target.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.status).toBe('DELETED');
    expect(after.deleted_at).not.toBeNull();
    expect(await prisma.resourceGrant.count({ where: { subject_id: target.id } })).toBe(0);
    // WP-K2: 소유 리소스 정리는 in-tx 가 아니라 퍼지 잡으로 표식된다(O(1), RT-27).
    // 어떤 리소스 타입이 정리되는지는 훅 레지스트리가 알고, 이 서비스는 모른다.
    expect(await prisma.ownerCleanupJob.count({ where: { user_id: target.id, status: 'PENDING' } })).toBe(1);
  });

  describe('최고관리자 보존 불변식 (§10.1, RI-1)', () => {
    /** 이 테넌트의 SUPER_ADMIN 을 정확히 지정한 수만 남긴다 */
    const resetSuperAdmins = async (count: number) => {
      await prisma.userRole.deleteMany({ where: { tenant_id: TENANT, role_id: roleIds['SUPER_ADMIN'] } });
      const created = [];
      for (let i = 0; i < count; i++) created.push(await createUser(['SUPER_ADMIN']));
      return created;
    };

    it('마지막 활성 SUPER_ADMIN 의 역할 회수·정지·삭제는 거부된다', async () => {
      const [last] = await resetSuperAdmins(1);
      const actor = await createUser(['SUPER_ADMIN']); // 행위자도 SUPER_ADMIN (총 2명)
      // 행위자 자신을 제외하면 last 가 유일 → last 를 강등하면 actor 가 남으므로 허용되어야 한다.
      // 여기서는 "정말 마지막 1명" 상황을 만들기 위해 actor 를 제외 대상으로 두고 검사한다.
      await prisma.userRole.deleteMany({ where: { user_id: actor.id, role_id: roleIds['SUPER_ADMIN'] } });

      await expect(
        prisma.$transaction(async (tx) => {
          await new SuperAdminGuardService().ensureRemains(tx, last.id, TENANT);
        }),
      ).rejects.toThrow(/마지막 활성 최고관리자/);
    });

    it('동시 요청 2건이 각각 다른 SUPER_ADMIN 을 강등해도 최소 1명은 남는다 (경쟁 조건)', async () => {
      const [a, b] = await resetSuperAdmins(2);
      const guard = new SuperAdminGuardService();

      // 두 트랜잭션이 동시에 "상대만 강등되면 나는 남는다"를 읽고 둘 다 통과하면 시스템이 잠긴다.
      // FOR UPDATE 직렬화가 이를 막아야 한다.
      const attempt = (targetId: string) =>
        prisma.$transaction(async (tx) => {
          await guard.ensureRemains(tx, targetId, TENANT);
          await tx.userRole.deleteMany({
            where: { user_id: targetId, role_id: roleIds['SUPER_ADMIN'] },
          });
          return targetId;
        });

      const results = await Promise.allSettled([attempt(a.id), attempt(b.id)]);
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;

      const remaining = await prisma.userRole.count({
        where: { role_id: roleIds['SUPER_ADMIN'], user: { status: 'ACTIVE' } },
      });
      expect(succeeded).toBe(1); // 한 건만 통과
      expect(remaining).toBeGreaterThanOrEqual(1); // 시스템 잠금 없음
    });

    it('동시 정지 2건도 마지막 1명을 남긴다', async () => {
      const [a, b] = await resetSuperAdmins(2);
      const guard = new SuperAdminGuardService();

      const attempt = (targetId: string) =>
        prisma.$transaction(async (tx) => {
          await guard.ensureRemains(tx, targetId, TENANT);
          await tx.user.update({ where: { id: targetId }, data: { status: 'SUSPENDED' } });
          return targetId;
        });

      const results = await Promise.allSettled([attempt(a.id), attempt(b.id)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const active = await prisma.userRole.count({
        where: { role_id: roleIds['SUPER_ADMIN'], user: { status: 'ACTIVE' } },
      });
      expect(active).toBeGreaterThanOrEqual(1);
    });
  });
});
