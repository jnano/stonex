/**
 * WP-11 통합 테스트 (실 DB) — FILE-3~5, Grant 실전 투입.
 * DoD:
 *  - 공유 → 수령자 즉시 접근, 회수 → 신규 발급 즉시 차단
 *  - 만료 Grant 가 접근·목록 양쪽에서 무효
 *  - 재공유 시도가 화이트리스트에서 차단 (ATK-11)
 *  - 관리자 경로가 file.update 를 부여하려 하면 거부
 *  - 자신을 subject 로 하는 Grant 생성 거부
 *  - canRevokeShare 가 소유자·생성자·관리자만 허용
 *  - 공유 생성과 리소스 삭제 경합에서 정리를 빠져나간 Grant 부재 (행 잠금)
 *  - DENY 존재 시 ALLOW 공유 생성이 거부됨
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { PolicyService } from '../src/authorization/policy.service';
import { SharesService } from '../src/files/shares.service';
import { FilesService } from '../src/files/files.service';
import { StorageService } from '../src/storage/storage.service';
import { UploadSessionService } from '../src/storage/upload-session.service';
import { AuthorizationService } from '../src/authorization/authorization.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { PermissionScope, SubjectSnapshot } from '../src/authorization/types';

jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009987';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const OWNER_PERMS: Array<[string, PermissionScope]> = [
  ['file.read', 'owned'], ['file.update', 'owned'], ['file.delete', 'owned'], ['file.share', 'owned'],
];
const ADMIN_PERMS: Array<[string, PermissionScope]> = [
  ...OWNER_PERMS, ['file.read.all', 'global'], ['file.share.all', 'global'],
];

describe('WP-11 파일 공유 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let shares: SharesService;
  let files: FilesService;
  let authz: AuthorizationService;
  let grants: ResourceGrantService;
  let ownerId: string;
  let granteeId: string;
  let strangerId: string;
  let adminId: string;

  const snap = (id: string, perms = OWNER_PERMS): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', permVersion: 1, roles: [], permissions: new Map(perms),
  });

  const makeFile = async (owner: string) =>
    prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: owner, name: `f-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });

  const fileRef = (id: string, owner: string, status = 'ACTIVE') =>
    ({ type: 'file', id, ownerId: owner, status, tenantId: TENANT });

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    execSync('pnpm db:seed', { cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe' });
    process.env.DATABASE_URL = TEST_URL;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    const audit = new AuditService();
    grants = new ResourceGrantService(audit);
    shares = new SharesService(p, grants, new PolicyService(), new PrismaGrantStore(p));
    const storage = new StorageService();
    files = new FilesService(p, audit, grants, storage, new UploadSessionService(p, storage), new PrismaGrantStore(p));
    authz = new AuthorizationService(new PrismaGrantStore(p));

    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'share-test' } });
    const mk = async (label: string) =>
      (await prisma.user.create({
        data: { tenant_id: TENANT, email: `${label}-${uid()}@t.local`, password_hash: 'x', name: label, status: 'ACTIVE' },
      })).id;
    ownerId = await mk('owner');
    granteeId = await mk('grantee');
    strangerId = await mk('stranger');
    adminId = await mk('admin');
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
  });

  it('FILE-4/5: 공유하면 수령자가 즉시 접근하고, 회수하면 즉시 차단된다', async () => {
    const file = await makeFile(ownerId);

    const before = await authz.can(snap(granteeId, []), 'file.read', fileRef(file.id, ownerId));
    expect(before.allow).toBe(false);

    const created = await shares.create(snap(ownerId), file.id, {
      subjectId: granteeId, permissions: ['file.read'],
    });
    expect(created).toHaveLength(1);

    const after = await authz.can(snap(granteeId, []), 'file.read', fileRef(file.id, ownerId));
    expect({ allow: after.allow, step: after.step }).toEqual({ allow: true, step: 4 });

    // 회수 — Grant 는 캐시하지 않으므로 다음 평가부터 즉시 반영된다(§8.3)
    await shares.revoke(snap(ownerId), file.id, created[0].grantId);
    const revoked = await authz.can(snap(granteeId, []), 'file.read', fileRef(file.id, ownerId));
    expect({ allow: revoked.allow, step: revoked.step }).toEqual({ allow: false, step: 5 });
  });

  it('ATK-11: 공유받은 자가 재공유할 수 없다 — 화이트리스트에서 file.share 제외', async () => {
    const file = await makeFile(ownerId);
    await shares.create(snap(ownerId), file.id, { subjectId: granteeId, permissions: ['file.read'] });

    // (a) 소유자조차 file.share 를 Grant 로 넘길 수 없다 — 전파의 원천 차단
    await expect(
      shares.create(snap(ownerId), file.id, { subjectId: strangerId, permissions: ['file.share'] }),
    ).rejects.toThrow(/부여할 수 없는 권한/);

    // (b) 수령자는 애초에 소유자가 아니고 file.share.all 도 없으므로 공유 경로 자체가 404
    await expect(
      shares.create(snap(granteeId, []), file.id, { subjectId: strangerId, permissions: ['file.read'] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('관리자 경로는 file.read 만 부여할 수 있다 (WT-3)', async () => {
    const file = await makeFile(ownerId);
    await expect(
      shares.create(snap(adminId, ADMIN_PERMS), file.id, { subjectId: granteeId, permissions: ['file.update'] }),
    ).rejects.toThrow(/file.read 만/);

    const ok = await shares.create(snap(adminId, ADMIN_PERMS), file.id, {
      subjectId: granteeId, permissions: ['file.read'],
    });
    expect(ok).toHaveLength(1);
    // 관리자 경로 Grant 는 만료가 강제된다(WT-7 — 부여자가 강등돼도 남는 잔존 창을 유한하게)
    expect(ok[0].expiresAt).not.toBeNull();
  });

  it('자신을 subject 로 하는 Grant 는 만들 수 없다 (WT-3)', async () => {
    const file = await makeFile(ownerId);
    await expect(
      shares.create(snap(adminId, ADMIN_PERMS), file.id, { subjectId: adminId, permissions: ['file.read'] }),
    ).rejects.toThrow(/자신에게/);
  });

  it('DENY 가 있으면 ALLOW 공유 생성이 거부된다 — 차단이 조용히 해제되지 않는다 (WT-6)', async () => {
    const file = await makeFile(ownerId);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'file.read' } });
    await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: granteeId, resource_type: 'file', resource_id: file.id,
        permission_id: perm.id, effect: 'DENY', granted_by: ownerId,
      },
    });

    await expect(
      shares.create(snap(ownerId), file.id, { subjectId: granteeId, permissions: ['file.read'] }),
    ).rejects.toMatchObject({ status: 409 });

    // DENY 가 그대로 남아 있어야 한다
    const still = await prisma.resourceGrant.findFirstOrThrow({
      where: { resource_id: file.id, subject_id: granteeId },
    });
    expect(still.effect).toBe('DENY');
  });

  it('만료된 Grant 는 접근·목록 양쪽에서 무효다', async () => {
    const file = await makeFile(ownerId);
    await shares.create(snap(ownerId), file.id, {
      subjectId: granteeId, permissions: ['file.read'], expiresAt: new Date(Date.now() - 1000),
    });

    const decision = await authz.can(snap(granteeId, []), 'file.read', fileRef(file.id, ownerId));
    expect(decision.allow).toBe(false);

    const { items } = await files.listVisible(snap(granteeId, []), 1, 100);
    expect(items.map((i) => i.id)).not.toContain(file.id);
  });

  describe('FILE-5 회수 권한 (canRevokeShare, §7.3)', () => {
    it('소유자·생성자·관리자만 회수할 수 있고 제3자는 거부된다', async () => {
      const file = await makeFile(ownerId);
      // 관리자가 만든 공유 → 생성자는 admin, 소유자는 owner
      const [share] = await shares.create(snap(adminId, ADMIN_PERMS), file.id, {
        subjectId: granteeId, permissions: ['file.read'],
      });

      // 제3자(수령자 포함)는 회수 불가
      await expect(shares.revoke(snap(strangerId, []), file.id, share.grantId)).rejects.toThrow();
      await expect(shares.revoke(snap(granteeId, []), file.id, share.grantId)).rejects.toThrow();

      // 생성자(관리자)는 회수 가능
      await shares.revoke(snap(adminId, ADMIN_PERMS), file.id, share.grantId);
      expect(await prisma.resourceGrant.count({ where: { id: share.grantId } })).toBe(0);
    });

    it('소유자는 타인이 만든 공유도 회수할 수 있다', async () => {
      const file = await makeFile(ownerId);
      const [share] = await shares.create(snap(adminId, ADMIN_PERMS), file.id, {
        subjectId: granteeId, permissions: ['file.read'],
      });
      await shares.revoke(snap(ownerId), file.id, share.grantId);
      expect(await prisma.resourceGrant.count({ where: { id: share.grantId } })).toBe(0);
    });
  });

  it('공유 생성과 파일 삭제가 경합해도 정리를 빠져나간 Grant 가 없다 (행 잠금, WT-10)', async () => {
    const file = await makeFile(ownerId);

    // 삭제와 생성을 동시에 던진다. 행 잠금이 없으면 생성 트랜잭션이 삭제 전 스냅샷을 읽고
    // INSERT 하여, 삭제가 지울 수 없는 Grant 가 남는다.
    const results = await Promise.allSettled([
      files.softDelete(snap(ownerId), file.id),
      shares.create(snap(ownerId), file.id, { subjectId: granteeId, permissions: ['file.read'] }),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const survived = await prisma.resourceGrant.count({ where: { resource_id: file.id } });
    const deleted = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    // 파일이 삭제됐다면 그 파일을 가리키는 Grant 는 하나도 남아 있으면 안 된다
    if (deleted.deleted_at) expect(survived).toBe(0);
  });

  it('공유 생성·회수가 감사 로그에 남는다 (INV-6)', async () => {
    const file = await makeFile(ownerId);
    const [share] = await shares.create(snap(ownerId), file.id, {
      subjectId: granteeId, permissions: ['file.read'],
    });
    await shares.revoke(snap(ownerId), file.id, share.grantId);

    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs WHERE target_id = ${file.id}::uuid ORDER BY created_at`;
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['grant.create', 'grant.revoke']));
  });
});
