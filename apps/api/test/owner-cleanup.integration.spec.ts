/**
 * 소유자 정리 훅·퍼지 워커 통합 테스트 (WP-K2, 실 DB).
 *
 * 고정하는 계약:
 *  - **가시성 창 0 (DEC-3)**: 소유자 삭제 표식이 커밋되는 즉시, 퍼지 전이라도
 *    로더는 404, 목록은 제외 — Grant 보유자에게도 보이지 않는다
 *  - 워커가 잡을 소화하면 파일·도메인이 소프트삭제되고 Grant 가 정리된다
 *    (도메인은 기존 정리 연쇄에서 빠져 있던 결함의 해소다)
 *  - 배치 상한에 걸리면 remaining — 잡이 PENDING 으로 남아 다음 틱에 계속된다(RT-27)
 *  - 훅 실패는 재시도 큐에 남고, 소진되면 FAILED — RI-10 순찰이 검출한다(격리 정책)
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { GovernanceFreezeService } from '../src/governance/freeze.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { ResourceLoaderRegistry } from '../src/authorization/resource-loader';
import { OwnerCleanupRegistry } from '../src/authorization/owner-cleanup';
import { FileOwnerCleanupHook } from '../src/files/file.cleanup';
import { DomainOwnerCleanupHook } from '../src/domains/domain.cleanup';
import { OwnerCleanupWorker } from '../src/members/owner-cleanup.worker';
import { INVARIANTS, loadSql } from '../src/governance/invariant.registry';
import { testRegistry } from './helpers/registry';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009982';
const uid = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('소유자 정리 (WP-K2, 실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let grants: ResourceGrantService;
  let loader: ResourceLoaderRegistry;
  let worker: OwnerCleanupWorker;
  let filePermId: string;

  const hooks = (): OwnerCleanupRegistry => {
    const r = new OwnerCleanupRegistry();
    r.register(new FileOwnerCleanupHook(p, grants));
    r.register(new DomainOwnerCleanupHook(p, grants));
    return r;
  };

  const createUser = async (deleted = false): Promise<string> =>
    (await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `u-${uid()}@t.local`, password_hash: 'x', name: 'u',
        status: deleted ? 'DELETED' : 'ACTIVE', deleted_at: deleted ? new Date() : null,
      },
    })).id;

  const createFile = async (ownerId: string): Promise<string> =>
    (await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: ownerId, name: `f-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 10n, mime_type: 'text/plain', checksum: 'c',
      },
    })).id;

  const createDomain = async (ownerId: string): Promise<string> =>
    (await prisma.domain.create({
      data: { tenant_id: TENANT, owner_id: ownerId, fqdn: `d-${uid()}.example.com`, status: 'VERIFIED' },
    })).id;

  const enqueue = async (userId: string): Promise<string> =>
    (await prisma.ownerCleanupJob.create({ data: { tenant_id: TENANT, user_id: userId } })).id;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    const audit = new AuditService();
    grants = new ResourceGrantService(audit, new GovernanceFreezeService(p, audit), testRegistry(p));
    loader = new ResourceLoaderRegistry(testRegistry(p));
    worker = new OwnerCleanupWorker(p, hooks());

    // 다른 스펙이 남긴 잡을 전부 비운다 — 워커 claim 은 created_at 순이라,
    // 잔여 잡이 있으면 이 스펙의 잡 대신 그것을 집어 검증이 어긋난다
    await prisma.ownerCleanupJob.deleteMany({});
    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'cleanup-test' } });
    filePermId = (await prisma.permission.upsert({
      where: { code: 'file.read' }, update: {},
      create: { code: 'file.read', scope: 'owned', module: 'core', description: 't' },
    })).id;
  });

  afterEach(async () => {
    await prisma.ownerCleanupJob.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domainTransfer.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domain.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('가시성 창 0 (DEC-3): 소유자 삭제 표식만으로 — 퍼지 전 — 로더가 즉시 404', async () => {
    const owner = await createUser();
    const fileId = await createFile(owner);
    const domainId = await createDomain(owner);

    // 퍼지 전: 리소스 행 자체는 아직 살아 있다
    await expect(loader.load('file', fileId)).resolves.toMatchObject({ id: fileId });

    // 소유자 삭제 표식 — 회원 삭제 트랜잭션이 하는 것과 동일한 O(1) 표식
    await prisma.user.update({ where: { id: owner }, data: { status: 'DELETED', deleted_at: new Date() } });

    // 리소스는 여전히 deleted_at=null 이지만(퍼지 전), 로더는 즉시 은닉한다.
    // 이것이 없으면 표식 커밋과 배치 정리 사이에 Grant 보유자가 접근하는 창이 생긴다.
    await expect(loader.load('file', fileId)).rejects.toThrow('Not Found');
    await expect(loader.load('domain', domainId)).rejects.toThrow('Not Found');
    expect((await prisma.file.findUniqueOrThrow({ where: { id: fileId } })).deleted_at).toBeNull();
  });

  it('워커가 잡을 소화: 파일·도메인 소프트삭제 + Grant 정리 + 이전 제안 무효화, 잡 DONE', async () => {
    const owner = await createUser(true);
    const grantee = await createUser();
    const fileId = await createFile(owner);
    const domainId = await createDomain(owner);
    await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: grantee, resource_type: 'file',
        resource_id: fileId, permission_id: filePermId, granted_by: owner,
      },
    });
    await prisma.domainTransfer.create({
      data: {
        tenant_id: TENANT, domain_id: domainId, from_user_id: owner, to_user_id: grantee,
        status: 'PENDING', expires_at: new Date(Date.now() + 86_400_000),
      },
    });
    const jobId = await enqueue(owner);

    await worker.tick();

    // 도메인 정리는 기존 삭제 연쇄에서 빠져 있던 결함이었다 — 훅 편입으로 해소
    expect((await prisma.file.findUniqueOrThrow({ where: { id: fileId } })).deleted_at).not.toBeNull();
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: domainId } })).deleted_at).not.toBeNull();
    expect(await prisma.resourceGrant.count({ where: { resource_id: fileId } })).toBe(0);
    expect((await prisma.domainTransfer.findFirstOrThrow({ where: { domain_id: domainId } })).status)
      .toBe('INVALIDATED');
    expect((await prisma.ownerCleanupJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('DONE');
  });

  it('배치 상한 초과분은 remaining — 잡이 PENDING 으로 남아 다음 배치가 이어받는다 (RT-27)', async () => {
    const owner = await createUser(true);
    for (let i = 0; i < 5; i++) await createFile(owner);
    const hook = new FileOwnerCleanupHook(p, grants);

    // 상한 2 로 1배치: 2건만 처리되고 remaining
    const first = await hook.purgeOwnerDeleted(owner, { tenantId: TENANT, actorId: null }, 2);
    expect(first).toEqual({ purged: 2, remaining: true });
    expect(await prisma.file.count({ where: { owner_id: owner, deleted_at: null } })).toBe(3);

    // 반복하면 소진된다 — 워커는 잡을 PENDING 으로 되돌려 이것을 틱 단위로 수행한다
    await hook.purgeOwnerDeleted(owner, { tenantId: TENANT, actorId: null }, 2);
    const last = await hook.purgeOwnerDeleted(owner, { tenantId: TENANT, actorId: null }, 2);
    expect(last).toEqual({ purged: 1, remaining: false });
  });

  it('훅 실패 격리: 재시도 큐에 남고, 소진되면 FAILED — RI-10 순찰이 검출한다', async () => {
    const owner = await createUser(true);
    const jobId = await enqueue(owner);

    const broken = new OwnerCleanupRegistry();
    broken.register({
      type: 'broken',
      purgeOwnerDeleted: async () => { throw new Error('훅 결함 시뮬레이션'); },
    });
    const brokenWorker = new OwnerCleanupWorker(p, broken);

    // MAX_ATTEMPTS(5) 소진까지 — 실패는 조용히 사라지지 않고 재시도 큐에 남는다
    for (let i = 0; i < 5; i++) {
      await brokenWorker.tick();
      const job = await prisma.ownerCleanupJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.attempts).toBe(i + 1);
      expect(job.status).toBe(i < 4 ? 'PENDING' : 'FAILED');
      expect(job.last_error).toContain('훅 결함');
    }

    // FAILED 는 순찰(RI-10)이 검출한다 — 훅 버그가 조용히 묻히지 않는다
    const def = INVARIANTS.find((d) => d.id === 'RI-10')!;
    const rows = await prisma.$queryRawUnsafe<Array<{ ri_id: string; subject: string }>>(loadSql(def));
    expect(rows.some((r) => r.subject === jobId)).toBe(true);

    // 정상 워커는 같은 잡을 다시 집지 않는다(FAILED 는 클레임 대상이 아니다) —
    // 원인 모른 채 자동 리셋하면 같은 실패를 무한 반복한다
    await worker.tick();
    expect((await prisma.ownerCleanupJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('FAILED');
  });
});
