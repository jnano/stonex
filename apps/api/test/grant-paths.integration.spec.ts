/**
 * Grant 평가 경로(2·4단계) 통합 테스트 — WP-3 DoD: resource_grants 수동 삽입 데이터로 검증.
 * 실제 PostgreSQL + PrismaGrantStore 경유 (인메모리 스토어가 아닌 실 인덱스 경로).
 */
import { testRegistry } from './helpers/registry';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { AuthorizationService } from '../src/authorization/authorization.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { PrismaService } from '../src/prisma/prisma.service';
import { PermissionScope, SubjectSnapshot } from '../src/authorization/types';

jest.setTimeout(60_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 테스트는 실제 DB를 요구).');

const TENANT = '00000000-0000-0000-0000-000000009998';

describe('Grant 평가 경로 2·4단계 (실 DB)', () => {
  let prisma: PrismaClient;
  let svc: AuthorizationService;
  let ownerId: string;
  let granteeId: string;
  let fileId: string;
  let readPermId: string;

  const snapshot = (id: string, perms: Array<[string, PermissionScope]> = []): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', permVersion: 1, roles: [], permissions: new Map(perms),
  });

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL; // PrismaService 가 테스트 DB를 보게 한다
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    svc = new AuthorizationService(new PrismaGrantStore(prisma as unknown as PrismaService), testRegistry(prisma as unknown as PrismaService));

    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'grant-test' } });
    const owner = await prisma.user.create({ data: { tenant_id: TENANT, email: `o-${Date.now()}@t.local`, password_hash: 'x', name: '소유자', status: 'ACTIVE' } });
    const grantee = await prisma.user.create({ data: { tenant_id: TENANT, email: `g-${Date.now()}@t.local`, password_hash: 'x', name: '수령자', status: 'ACTIVE' } });
    const f = await prisma.file.create({ data: { tenant_id: TENANT, owner_id: owner.id, name: 't.txt', storage_key: 'k', size_bytes: 1n, mime_type: 'text/plain', checksum: 'c' } });
    const readPerm = await prisma.permission.upsert({
      where: { code: 'file.read' },
      update: {},
      create: { code: 'file.read', description: '소유 파일 조회', scope: 'owned' },
    });
    ownerId = owner.id; granteeId = grantee.id; fileId = f.id; readPermId = readPerm.id;
  });

  afterAll(async () => {
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
  });

  const fileRef = () => ({ type: 'file', id: fileId, ownerId, status: 'ACTIVE', tenantId: TENANT });

  it('ALLOW Grant 삽입 → 4단계 허용, 회수(삭제) → 즉시 5단계 거부', async () => {
    const grant = await prisma.resourceGrant.create({
      data: { tenant_id: TENANT, subject_id: granteeId, resource_type: 'file', resource_id: fileId, permission_id: readPermId, effect: 'ALLOW', granted_by: ownerId },
    });
    const allowed = await svc.can(snapshot(granteeId), 'file.read', fileRef());
    expect({ allow: allowed.allow, step: allowed.step }).toEqual({ allow: true, step: 4 });

    await prisma.resourceGrant.delete({ where: { id: grant.id } }); // 공유 회수(FILE-5)
    const revoked = await svc.can(snapshot(granteeId), 'file.read', fileRef());
    expect({ allow: revoked.allow, step: revoked.step }).toEqual({ allow: false, step: 5 });
  });

  it('만료된 ALLOW Grant 는 무효 (5단계 거부)', async () => {
    await prisma.resourceGrant.create({
      data: { tenant_id: TENANT, subject_id: granteeId, resource_type: 'file', resource_id: fileId, permission_id: readPermId, effect: 'ALLOW', granted_by: ownerId, expires_at: new Date(Date.now() - 1000) },
    });
    const d = await svc.can(snapshot(granteeId), 'file.read', fileRef());
    expect({ allow: d.allow, step: d.step }).toEqual({ allow: false, step: 5 });
    await prisma.resourceGrant.deleteMany({ where: { subject_id: granteeId } });
  });

  it('DENY Grant 는 소유자의 owned 권한보다 우선한다 (2단계, INV-4)', async () => {
    await prisma.resourceGrant.create({
      data: { tenant_id: TENANT, subject_id: ownerId, resource_type: 'file', resource_id: fileId, permission_id: readPermId, effect: 'DENY', granted_by: ownerId },
    });
    const d = await svc.can(snapshot(ownerId, [['file.read', 'owned']]), 'file.read', fileRef());
    expect({ allow: d.allow, step: d.step }).toEqual({ allow: false, step: 2 });
    await prisma.resourceGrant.deleteMany({ where: { subject_id: ownerId } });
  });
});
