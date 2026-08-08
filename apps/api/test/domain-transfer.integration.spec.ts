/**
 * WP-13 통합 테스트 (실 DB) — DOM-5 운영 위임 · DOM-6 소유자 이전.
 *
 * DoD:
 *  - 위임 수임자가 조회·수정·검증 가능 / 삭제·이전 불가 / **재위임 거부**
 *  - 수령자만 수락 가능 (제3자·발의자 본인 거부)
 *  - 발의자 정지 후 수락 거부 / SUSPENDED 도메인 이전 거부 / 만료 후 수락 거부
 *  - 이전 완료 시 ALLOW Grant 삭제 · DENY Grant 승계
 *  - 미수락 상태에서 소유권 불변
 *  - 동시 발의 2건 경합 시 1건만 성립
 *  - 만료된 발의가 재발의를 막지 않는다 (지연 만료)
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { GovernanceFreezeService } from '../src/governance/freeze.service';
import { AuditService } from '../src/audit/audit.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { AuthorizationService } from '../src/authorization/authorization.service';
import { PolicyService } from '../src/authorization/policy.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { ResourceLoaderRegistry } from '../src/authorization/resource-loader';
import { DomainsService } from '../src/domains/domains.service';
import { DomainDelegationsService } from '../src/domains/delegations.service';
import { DomainTransfersService } from '../src/domains/transfers.service';
import { PermissionScope, SubjectSnapshot } from '../src/authorization/types';
import { PERMISSIONS } from '../../../db/seeds/permissions';

jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

// 스펙 전용 테넌트 (병렬 실행 중 다른 스펙의 정리에 휩쓸리지 않도록)
const TENANT = '00000000-0000-0000-0000-000000009985';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const MEMBER_PERMS: Array<[string, PermissionScope]> = [
  ['domain.read', 'owned'], ['domain.update', 'owned'], ['domain.verify', 'owned'],
  ['domain.delete', 'owned'], ['domain.transfer', 'owned'], ['domain.share', 'owned'],
];
const CREATOR_PERMS: Array<[string, PermissionScope]> = [
  ...MEMBER_PERMS, ['domain.create', 'global'],
];

describe('WP-13 도메인 위임·소유자 이전 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let domains: DomainsService;
  let delegations: DomainDelegationsService;
  let transfers: DomainTransfersService;
  let authz: AuthorizationService;
  let loader: ResourceLoaderRegistry;
  let ownerId: string;
  let granteeId: string;
  let strangerId: string;
  const permIds: Record<string, string> = {};

  const snapshot = (id: string, perms = CREATOR_PERMS): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', permVersion: 1, roles: [], permissions: new Map(perms),
  });

  const makeDomain = (owner = ownerId) => domains.create(snapshot(owner), `t-${uid()}.example.com`);
  const rowOf = (id: string) => prisma.domain.findUniqueOrThrow({ where: { id } });

  const makeUser = async (label: string) =>
    prisma.user.create({
      data: {
        tenant_id: TENANT, email: `${label}-${uid()}@t.local`, password_hash: 'x',
        name: label, status: 'ACTIVE',
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
    const grants = new ResourceGrantService(audit, new GovernanceFreezeService(p, audit));
    const store = new PrismaGrantStore(p);
    const policy = new PolicyService();
    domains = new DomainsService(p, audit, grants, store);
    delegations = new DomainDelegationsService(p, grants, policy, store);
    transfers = new DomainTransfersService(p, audit, grants, policy, store);
    authz = new AuthorizationService(store);
    loader = new ResourceLoaderRegistry(p);

    await prisma.tenant.upsert({
      where: { id: TENANT }, update: {}, create: { id: TENANT, name: `t-${uid()}` },
    });
    ownerId = (await makeUser('owner')).id;
    granteeId = (await makeUser('grantee')).id;
    strangerId = (await makeUser('stranger')).id;

    // Grant 생성은 실제 Permission 행을 요구한다 — 시드 정의를 그대로 쓴다
    for (const def of PERMISSIONS.filter((d) => d.code.startsWith('domain.'))) {
      const row = await prisma.permission.upsert({
        where: { code: def.code }, update: {},
        create: { code: def.code, description: def.description, scope: def.scope, module: def.module },
      });
      permIds[def.code] = row.id;
    }
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.domainTransfer.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domainVerificationAttempt.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domain.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  // ── DOM-5 위임 ────────────────────────────────────────────────
  describe('DOM-5 운영 위임', () => {
    it('위임하면 수임자가 조회·수정·검증까지 가능하고, 삭제·이전은 불가하다', async () => {
      const domain = await makeDomain();
      await delegations.create(snapshot(ownerId), domain.id, {
        subjectId: granteeId, permissions: ['domain.update', 'domain.verify'],
      });
      const ref = await loader.load('domain', domain.id);
      const grantee = snapshot(granteeId, MEMBER_PERMS);

      for (const code of ['domain.read', 'domain.update', 'domain.verify']) {
        const d = await authz.can(grantee, code, ref);
        expect({ code, allow: d.allow, step: d.step }).toEqual({ code, allow: true, step: 4 });
      }
      // 삭제·이전은 화이트리스트 밖이라 Grant 자체가 없다 → default deny
      for (const code of ['domain.delete', 'domain.transfer']) {
        const d = await authz.can(grantee, code, ref);
        expect({ code, allow: d.allow, step: d.step }).toEqual({ code, allow: false, step: 5 });
      }
    });

    it('요청에 domain.read 가 없어도 항상 포함된다 (RT-14 — 운영 불능 방지)', async () => {
      const domain = await makeDomain();
      // read 없이 update 만 주면 수임자는 §10.2 존재 은닉 때문에 대상을 404 로 보면서
      // 수정만 가능한 상태가 된다 — 서비스가 read 를 강제로 덧붙인다.
      const result = await delegations.create(snapshot(ownerId), domain.id, {
        subjectId: granteeId, permissions: ['domain.update'],
      });
      expect(result.map((r) => r.permission).sort()).toEqual(['domain.read', 'domain.update']);
    });

    it('수임자의 재위임은 거부된다 (ATK-11 도메인판 — domain.share 는 화이트리스트에 없다)', async () => {
      const domain = await makeDomain();
      await delegations.create(snapshot(ownerId), domain.id, {
        subjectId: granteeId, permissions: ['domain.update'],
      });
      // 소유자조차 domain.share 를 Grant 로 넘길 수 없다 — 전파가 원천 차단된다
      await expect(
        delegations.create(snapshot(ownerId), domain.id, {
          subjectId: strangerId, permissions: ['domain.share'],
        }),
      ).rejects.toMatchObject({ status: 403 });

      // transfer·delete 도 같은 이유로 위임 불가
      for (const code of ['domain.transfer', 'domain.delete']) {
        await expect(
          delegations.create(snapshot(ownerId), domain.id, { subjectId: strangerId, permissions: [code] }),
        ).rejects.toMatchObject({ status: 403 });
      }
    });

    it('회수는 소유자·생성자·관리자만 가능하고 수임자는 불가하다', async () => {
      const domain = await makeDomain();
      const [grant] = await delegations.create(snapshot(ownerId), domain.id, {
        subjectId: granteeId, permissions: ['domain.update'],
      });

      // 수임자 본인은 회수할 수 없다
      await expect(
        delegations.revoke(snapshot(granteeId, MEMBER_PERMS), domain.id, grant.grantId),
      ).rejects.toMatchObject({ status: 403 });

      // domain.share.all 보유자(관리자)는 가능하다 — 소유자 정지 시 유일한 경로
      const admin = snapshot(strangerId, [...MEMBER_PERMS, ['domain.share.all', 'global']]);
      await delegations.revoke(admin, domain.id, grant.grantId);
      expect(await prisma.resourceGrant.count({ where: { id: grant.grantId } })).toBe(0);
    });
  });

  // ── DOM-6 이전 ────────────────────────────────────────────────
  describe('DOM-6 소유자 이전', () => {
    it('발의만으로는 소유권이 바뀌지 않고, 수령자가 수락해야 넘어간다', async () => {
      const domain = await makeDomain();
      const transfer = await transfers.propose(snapshot(ownerId), domain.id, granteeId);
      expect(transfer.status).toBe('PENDING');
      expect((await rowOf(domain.id)).owner_id).toBe(ownerId); // 미수락 상태에서 불변

      const accepted = await transfers.accept(snapshot(granteeId, MEMBER_PERMS), transfer.id);
      expect(accepted.status).toBe('ACCEPTED');
      expect((await rowOf(domain.id)).owner_id).toBe(granteeId);

      const logs = await prisma.$queryRaw<Array<{ action: string }>>`
        SELECT action FROM audit.audit_logs
         WHERE target_id = ${domain.id}::uuid AND action LIKE 'domain.transfer%'
         ORDER BY action`;
      expect(logs.map((l) => l.action)).toEqual(['domain.transfer.accept', 'domain.transfer.propose']);
    });

    it('수령자가 아닌 사람은 수락할 수 없다 (제3자·발의자 본인 모두)', async () => {
      const domain = await makeDomain();
      const transfer = await transfers.propose(snapshot(ownerId), domain.id, granteeId);

      // 존재 자체를 숨긴다(§10.2)
      await expect(transfers.accept(snapshot(strangerId, MEMBER_PERMS), transfer.id))
        .rejects.toMatchObject({ status: 404 });
      await expect(transfers.accept(snapshot(ownerId), transfer.id))
        .rejects.toMatchObject({ status: 404 });
      expect((await rowOf(domain.id)).owner_id).toBe(ownerId);
    });

    it('발의자가 정지되면 수락이 거부되고 발의가 무효 종료된다', async () => {
      const proposer = await makeUser('suspended-proposer');
      const domain = await domains.create(snapshot(proposer.id), `sus-${uid()}.example.com`);
      const transfer = await transfers.propose(snapshot(proposer.id), domain.id, granteeId);

      await prisma.user.update({ where: { id: proposer.id }, data: { status: 'SUSPENDED' } });

      await expect(transfers.accept(snapshot(granteeId, MEMBER_PERMS), transfer.id))
        .rejects.toMatchObject({ status: 403 });
      const after = await prisma.domainTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
      // 무효 종료가 **롤백되지 않고 남아야** 한다 — 남지 않으면 PENDING 슬롯을 계속 점유한다
      expect(after.status).toBe('INVALIDATED');
      expect((await rowOf(domain.id)).owner_id).toBe(proposer.id);
    });

    it('SUSPENDED 도메인은 이전할 수 없다', async () => {
      const domain = await makeDomain();
      const transfer = await transfers.propose(snapshot(ownerId), domain.id, granteeId);
      await prisma.domain.update({ where: { id: domain.id }, data: { status: 'SUSPENDED' } });

      await expect(transfers.accept(snapshot(granteeId, MEMBER_PERMS), transfer.id))
        .rejects.toMatchObject({ status: 403 });
      expect((await rowOf(domain.id)).owner_id).toBe(ownerId);
    });

    it('만료된 발의는 수락되지 않고, 같은 도메인에 재발의할 수 있다 (지연 만료)', async () => {
      const domain = await makeDomain();
      const transfer = await transfers.propose(snapshot(ownerId), domain.id, granteeId);
      await prisma.domainTransfer.update({
        where: { id: transfer.id }, data: { expires_at: new Date(Date.now() - 1000) },
      });

      await expect(transfers.accept(snapshot(granteeId, MEMBER_PERMS), transfer.id))
        .rejects.toMatchObject({ status: 403 });

      // 만료 발의가 PENDING 으로 남아 있으면 부분 유니크가 재발의를 영구히 막는다
      const again = await transfers.propose(snapshot(ownerId), domain.id, granteeId);
      expect(again.status).toBe('PENDING');
      expect(again.id).not.toBe(transfer.id);
    });

    it('수락 시 ALLOW Grant 는 삭제되고 DENY Grant 는 승계된다', async () => {
      const domain = await makeDomain();
      await delegations.create(snapshot(ownerId), domain.id, {
        subjectId: strangerId, permissions: ['domain.update'],
      });
      // 제3자에게 걸린 제재(DENY)는 리소스에 붙은 것이지 소유자에 붙은 게 아니다
      const denied = await makeUser('denied');
      await prisma.resourceGrant.create({
        data: {
          tenant_id: TENANT, subject_id: denied.id, resource_type: 'domain', resource_id: domain.id,
          permission_id: permIds['domain.read'], effect: 'DENY', granted_by: ownerId,
        },
      });

      const transfer = await transfers.propose(snapshot(ownerId), domain.id, granteeId);
      await transfers.accept(snapshot(granteeId, MEMBER_PERMS), transfer.id);

      const remaining = await prisma.resourceGrant.findMany({ where: { resource_id: domain.id } });
      // 소유권 왕복만으로 제재가 풀리면 DENY 는 무의미해진다
      expect(remaining.map((g) => g.effect)).toEqual(['DENY']);
      expect(remaining[0].subject_id).toBe(denied.id);
    });

    it('수령자에게 DENY 가 걸려 있으면 수락이 거부된다 (관리 불능 소유자 방지)', async () => {
      const domain = await makeDomain();
      await prisma.resourceGrant.create({
        data: {
          tenant_id: TENANT, subject_id: granteeId, resource_type: 'domain', resource_id: domain.id,
          permission_id: permIds['domain.read'], effect: 'DENY', granted_by: ownerId,
        },
      });
      const transfer = await transfers.propose(snapshot(ownerId), domain.id, granteeId);

      await expect(transfers.accept(snapshot(granteeId, MEMBER_PERMS), transfer.id))
        .rejects.toMatchObject({ status: 403 });
      expect((await rowOf(domain.id)).owner_id).toBe(ownerId);
    });

    it('동시 발의 2건이 경합해도 1건만 성립한다', async () => {
      const domain = await makeDomain();
      const results = await Promise.allSettled([
        transfers.propose(snapshot(ownerId), domain.id, granteeId),
        transfers.propose(snapshot(ownerId), domain.id, strangerId),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok).toHaveLength(1);
      expect(await prisma.domainTransfer.count({ where: { domain_id: domain.id, status: 'PENDING' } }))
        .toBe(1);
    });

    it('자기 자신·비활성 계정으로는 발의할 수 없다', async () => {
      const domain = await makeDomain();
      await expect(transfers.propose(snapshot(ownerId), domain.id, ownerId))
        .rejects.toMatchObject({ status: 400 });

      const inactive = await makeUser('inactive');
      await prisma.user.update({ where: { id: inactive.id }, data: { status: 'SUSPENDED' } });
      await expect(transfers.propose(snapshot(ownerId), domain.id, inactive.id))
        .rejects.toMatchObject({ status: 409 });
    });

    it('만료 스윕이 PENDING 발의를 EXPIRED 로 정리한다', async () => {
      const domain = await makeDomain();
      const transfer = await transfers.propose(snapshot(ownerId), domain.id, granteeId);
      await prisma.domainTransfer.update({
        where: { id: transfer.id }, data: { expires_at: new Date(Date.now() - 1000) },
      });

      expect(await transfers.sweepExpired()).toBeGreaterThanOrEqual(1);
      const after = await prisma.domainTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
      expect(after.status).toBe('EXPIRED');
    });
  });
});
