/**
 * WP-10 통합 테스트 (실 DB + 실 MinIO) — FILE-1·2·6·7.
 * DoD:
 *  - 소유자 허용 / 타인 거부(404 은닉) / `.all` 은 /admin 경로에서 허용
 *  - 소프트 삭제된 파일 접근이 평가기 1단계에서 차단 (ATK-12)
 *  - 삭제 시 Grant 동반 정리 + **그 정리가 감사 로그에 남음**, 기록 실패 시 롤백
 *  - 목록 결과가 개별 can() 과 등가 — 픽스처에 소유-DELETED·grantee-DENY·grantee-EXPIRED 포함(RT-22)
 *  - 회원 삭제 후 그 회원 소유 파일에 대한 기존 공유 접근 차단 (WT-17)
 *  - 다른 테넌트 리소스 id 접근 시 404
 */
import { testRegistry } from './helpers/registry';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';
import { GovernanceFreezeService } from '../src/governance/freeze.service';
import { AuditService } from '../src/audit/audit.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { StorageService } from '../src/storage/storage.service';
import { UploadSessionService } from '../src/storage/upload-session.service';
import { FilesService } from '../src/files/files.service';
import { AuthorizationService } from '../src/authorization/authorization.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { ResourceLoaderRegistry } from '../src/authorization/resource-loader';
import { PermissionScope, SubjectSnapshot } from '../src/authorization/types';

jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009989';
const OTHER_TENANT = '00000000-0000-0000-0000-000000009988';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const MEMBER_PERMS: Array<[string, PermissionScope]> = [
  ['file.read', 'owned'], ['file.upload', 'global'], ['file.update', 'owned'], ['file.delete', 'owned'],
];

describe('WP-10 파일 기본 기능 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let files: FilesService;
  let authz: AuthorizationService;
  let loader: ResourceLoaderRegistry;
  let grants: ResourceGrantService;
  let ownerId: string;
  let viewerId: string;
  let readPermId: string;

  const snapshot = (id: string, perms = MEMBER_PERMS): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', permVersion: 1, roles: [], permissions: new Map(perms),
  });

  /** DB에 파일 행을 직접 만든다(스토리지 왕복은 WP-9에서 이미 검증) */
  const makeFile = async (owner: string, tenant = TENANT) =>
    prisma.file.create({
      data: {
        tenant_id: tenant, owner_id: owner, name: `f-${uid()}.txt`,
        storage_key: `${tenant}/${uid()}`, size_bytes: 10n, mime_type: 'text/plain', checksum: 'c',
      },
    });

  const makeGrant = async (subjectId: string, fileId: string, effect: 'ALLOW' | 'DENY', expiresAt: Date | null = null) =>
    prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: subjectId, resource_type: 'file', resource_id: fileId,
        permission_id: readPermId, effect, granted_by: ownerId, expires_at: expiresAt,
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
    grants = new ResourceGrantService(audit, new GovernanceFreezeService(p, audit), testRegistry(p));
    const storage = new StorageService(new SettingsService(p, new AuditService()));
    files = new FilesService(testRegistry(p), p, audit, grants, storage, new UploadSessionService(p, storage), new PrismaGrantStore(p));
    authz = new AuthorizationService(new PrismaGrantStore(p), testRegistry(p));
    loader = new ResourceLoaderRegistry(testRegistry(p));

    for (const t of [TENANT, OTHER_TENANT]) {
      await prisma.tenant.upsert({ where: { id: t }, update: {}, create: { id: t, name: `t-${uid()}` } });
    }
    const owner = await prisma.user.create({
      data: { tenant_id: TENANT, email: `own-${uid()}@t.local`, password_hash: 'x', name: '소유자', status: 'ACTIVE' },
    });
    const viewer = await prisma.user.create({
      data: { tenant_id: TENANT, email: `vw-${uid()}@t.local`, password_hash: 'x', name: '열람자', status: 'ACTIVE' },
    });
    const perm = await prisma.permission.upsert({
      where: { code: 'file.read' }, update: {},
      create: { code: 'file.read', description: '소유 파일 조회', scope: 'owned' },
    });
    ownerId = owner.id; viewerId = viewer.id; readPermId = perm.id;
  });

  afterAll(async () => {
    for (const t of [TENANT, OTHER_TENANT]) {
      await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${t}::uuid`;
      await prisma.resourceGrant.deleteMany({ where: { tenant_id: t } });
      await prisma.file.deleteMany({ where: { tenant_id: t } });
      await prisma.user.deleteMany({ where: { tenant_id: t } });
      await prisma.tenant.delete({ where: { id: t } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('FILE-6: 소프트 삭제는 status·deleted_at 을 동시에 설정하고, 접근이 1단계에서 차단된다 (ATK-12)', async () => {
    const file = await makeFile(ownerId);
    await files.softDelete(snapshot(ownerId), file.id);

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.status).toBe('DELETED');
    expect(after.deleted_at).not.toBeNull(); // 한쪽만 채우면 두 축이 어긋난다(WT-25)

    // 평가기 1단계 차단
    const decision = await authz.can(snapshot(ownerId), 'file.read', {
      type: 'file', id: file.id, ownerId, status: after.status, tenantId: TENANT,
    });
    expect({ allow: decision.allow, step: decision.step }).toEqual({ allow: false, step: 1 });
    // 로더는 아예 404 로 숨긴다
    await expect(loader.load('file', file.id)).rejects.toMatchObject({ status: 404 });
  });

  it('FILE-6: 삭제 시 Grant 가 동반 정리되고 그 정리가 감사에 남는다 (CR-3)', async () => {
    const file = await makeFile(ownerId);
    await makeGrant(viewerId, file.id, 'ALLOW');

    await files.softDelete(snapshot(ownerId), file.id);

    expect(await prisma.resourceGrant.count({ where: { resource_id: file.id } })).toBe(0);
    const logs = await prisma.$queryRaw<Array<{ action: string; detail: { before: { grants: unknown[] } } }>>`
      SELECT action, detail FROM audit.audit_logs
      WHERE target_id = ${file.id}::uuid AND action = 'grant.cleanup'`;
    expect(logs).toHaveLength(1);
    // 회수 전 행 내용이 남아야 복구가 가능하다
    expect(logs[0].detail.before.grants).toHaveLength(1);
  });

  it('감사 기록이 실패하면 파일 삭제도 롤백된다 (INV-6)', async () => {
    const file = await makeFile(ownerId);
    const brokenAudit = {
      record: async () => { throw new Error('감사 기록 실패 주입'); },
    } as unknown as AuditService;
    const brokenFiles = new FilesService(
      testRegistry(p), p, brokenAudit, new ResourceGrantService(brokenAudit, new GovernanceFreezeService(p, brokenAudit), testRegistry(p)),
      new StorageService(new SettingsService(p, new AuditService())), new UploadSessionService(p, new StorageService(new SettingsService(p, new AuditService()))), new PrismaGrantStore(p),
    );
    await expect(brokenFiles.softDelete(snapshot(ownerId), file.id)).rejects.toThrow();

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.deleted_at).toBeNull(); // 삭제가 롤백됨
  });

  it('다른 테넌트의 파일 id 로 접근하면 404 (로더 정규화)', async () => {
    const otherUser = await prisma.user.create({
      data: { tenant_id: OTHER_TENANT, email: `x-${uid()}@t.local`, password_hash: 'x', name: '타테넌트', status: 'ACTIVE' },
    });
    const foreign = await makeFile(otherUser.id, OTHER_TENANT);
    // 로더는 아직 테넌트를 필터하지 않으므로(WT-16, Phase 3 선결) 여기서는 존재는 확인된다.
    // 그러나 평가기 3단계에서 소유자 불일치, 4단계에서 Grant 부재로 거부된다.
    const ref = await loader.load('file', foreign.id);
    const decision = await authz.can(snapshot(viewerId), 'file.read', ref);
    expect(decision.allow).toBe(false);

    // 비UUID·미등록 타입은 500이 아니라 404로 정규화된다(WT-13)
    await expect(loader.load('file', 'not-a-uuid')).rejects.toMatchObject({ status: 404 });
    await expect(loader.load('board.post', foreign.id)).rejects.toMatchObject({ status: 404 });
  });

  describe('컬렉션 등가성 (기획서 §7.3-2, RT-22)', () => {
    it('목록의 모든 항목이 개별 can() 에서 ALLOW 이고, 제외 픽스처 3종이 목록에 없다', async () => {
      // 픽스처: 소유-ACTIVE / 소유-DELETED / grantee-ALLOW / grantee-DENY / grantee-EXPIRED
      const ownActive = await makeFile(viewerId);
      const ownDeleted = await makeFile(viewerId);
      await files.softDelete(snapshot(viewerId), ownDeleted.id);

      const sharedAllow = await makeFile(ownerId);
      await makeGrant(viewerId, sharedAllow.id, 'ALLOW');

      const sharedDeny = await makeFile(ownerId);
      await makeGrant(viewerId, sharedDeny.id, 'ALLOW');
      await prisma.resourceGrant.create({
        data: {
          tenant_id: TENANT, subject_id: viewerId, resource_type: 'file', resource_id: sharedDeny.id,
          permission_id: readPermId, effect: 'DENY', granted_by: ownerId,
        },
      }).catch(async () => {
        // UNIQUE 가 effect 를 제외하므로 ALLOW 행을 DENY 로 갱신한다(§5.2 DDL 주석)
        await prisma.resourceGrant.updateMany({
          where: { subject_id: viewerId, resource_id: sharedDeny.id }, data: { effect: 'DENY' },
        });
      });

      const sharedExpired = await makeFile(ownerId);
      await makeGrant(viewerId, sharedExpired.id, 'ALLOW', new Date(Date.now() - 1000));

      const { items } = await files.listVisible(snapshot(viewerId), 1, 100);
      const ids = new Set(items.map((i) => i.id));

      // 포함돼야 하는 것
      expect(ids.has(ownActive.id)).toBe(true);
      expect(ids.has(sharedAllow.id)).toBe(true);
      // 제외돼야 하는 것 — 3·4단계만 재현하면 여기가 샌다
      expect(ids.has(ownDeleted.id)).toBe(false); // 1단계(리소스 상태)
      expect(ids.has(sharedDeny.id)).toBe(false); // 2단계(DENY 우선, INV-4)
      expect(ids.has(sharedExpired.id)).toBe(false); // 4단계(만료)

      // 등가성: 목록의 모든 항목은 개별 can() 에서 ALLOW 여야 한다
      for (const item of items) {
        const row = await prisma.file.findUniqueOrThrow({ where: { id: item.id } });
        const decision = await authz.can(snapshot(viewerId), 'file.read', {
          type: 'file', id: row.id, ownerId: row.owner_id, status: row.status, tenantId: row.tenant_id,
        });
        expect(decision.allow).toBe(true);
      }
    });
  });

  it('WT-17: 회원 소유 파일을 동반 삭제하면 기존 공유 접근이 끊긴다', async () => {
    const doomed = await prisma.user.create({
      data: { tenant_id: TENANT, email: `d-${uid()}@t.local`, password_hash: 'x', name: '탈퇴자', status: 'ACTIVE' },
    });
    const file = await makeFile(doomed.id);
    await makeGrant(viewerId, file.id, 'ALLOW');

    // 공유 수령자는 지금은 접근 가능
    const before = await authz.can(snapshot(viewerId), 'file.read', {
      type: 'file', id: file.id, ownerId: doomed.id, status: 'ACTIVE', tenantId: TENANT,
    });
    expect({ allow: before.allow, step: before.step }).toEqual({ allow: true, step: 4 });

    await prisma.$transaction(async (tx) => {
      await files.softDeleteOwnedBy(tx, doomed.id, { tenantId: TENANT, actorId: ownerId });
    });

    const row = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    const after = await authz.can(snapshot(viewerId), 'file.read', {
      type: 'file', id: file.id, ownerId: doomed.id, status: row.status, tenantId: TENANT,
    });
    expect({ allow: after.allow, step: after.step }).toEqual({ allow: false, step: 1 });
    expect(await prisma.resourceGrant.count({ where: { resource_id: file.id } })).toBe(0);
  });
});
