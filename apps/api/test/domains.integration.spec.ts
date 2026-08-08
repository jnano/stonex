/**
 * WP-12 통합 테스트 (실 DB) — DOM-1·2·3·4·7.
 *
 * DoD:
 *  - 소유자 허용 / Grant 수임자 허용 / 타인 거부 / `.all` 은 관리자 경로
 *  - **SUSPENDED 도메인은 조회는 되고 수정은 거부**된다 (§4.7 readExtra 예외)
 *  - 소프트 삭제된 도메인 접근이 평가기 1단계에서 차단된다
 *  - 목록 컬렉션 등가성 — 소유-DELETED · grantee-DENY · grantee-EXPIRED 포함 (RT-22)
 *  - DNS 성공 → VERIFIED / 실패 → 상태 불변 + 사유 기록
 *  - DNS 가 멈춰도 검증 요청 API 는 즉시 반환하고 워커를 점유하지 않는다
 *  - 검증 토큰이 추측 불가능하고 재사용되지 않는다
 *  - 이전받은 MEMBER 가 자기 도메인을 수정·검증·삭제할 수 있다 (기획서 v1.7 §4.5)
 *  - 소프트 삭제 후 같은 FQDN 재등록이 가능하다 (부분 유니크)
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { AuthorizationService } from '../src/authorization/authorization.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { ResourceLoaderRegistry } from '../src/authorization/resource-loader';
import { DomainsService } from '../src/domains/domains.service';
import { DomainVerificationService } from '../src/domains/verification.service';
import { DnsTxtResolver } from '../src/domains/dns-resolver';
import { txtRecordValue } from '../src/domains/fqdn';
import { ROLES } from '../../../db/seeds/permissions';
import { PermissionScope, SubjectSnapshot } from '../src/authorization/types';

jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

// 스펙마다 전용 테넌트를 쓴다 — jest 는 파일을 병렬 실행하므로, 같은 테넌트를 쓰는 스펙끼리는
// 서로의 afterAll 정리에 데이터가 지워진다(9987 은 shares 스펙이 사용 중).
const TENANT = '00000000-0000-0000-0000-000000009986';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** MEMBER 의 도메인 권한 — v1.7 §4.5 에서 owned 5종이 부여됐다 */
const MEMBER_PERMS: Array<[string, PermissionScope]> = [
  ['domain.read', 'owned'], ['domain.update', 'owned'], ['domain.verify', 'owned'],
  ['domain.delete', 'owned'], ['domain.transfer', 'owned'], ['domain.share', 'owned'],
];
const CREATOR_PERMS: Array<[string, PermissionScope]> = [
  ...MEMBER_PERMS, ['domain.create', 'global'],
];

/** 교체 가능한 DNS 조회기 — 테스트가 응답을 완전히 통제한다 */
class FakeResolver implements DnsTxtResolver {
  records = new Map<string, string[]>();
  /** true 면 조회가 영원히 멈춘다 (상위 리졸버 장애 재현) */
  hang = false;
  calls = 0;

  async resolveTxt(fqdn: string): Promise<string[]> {
    this.calls += 1;
    if (this.hang) await new Promise<void>(() => undefined);
    return this.records.get(fqdn) ?? [];
  }
}

describe('WP-12 도메인 기본 기능 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let domains: DomainsService;
  let verification: DomainVerificationService;
  let authz: AuthorizationService;
  let loader: ResourceLoaderRegistry;
  let dns: FakeResolver;
  let ownerId: string;
  let viewerId: string;
  let readPermId: string;

  const snapshot = (id: string, perms = CREATOR_PERMS): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', permVersion: 1, roles: [], permissions: new Map(perms),
  });

  const makeDomain = async (owner: string, fqdn = `d-${uid()}.example.com`) =>
    domains.create(snapshot(owner), fqdn);

  const rowOf = (id: string) => prisma.domain.findUniqueOrThrow({ where: { id } });

  const makeGrant = async (subjectId: string, domainId: string, effect: 'ALLOW' | 'DENY', expiresAt: Date | null = null) =>
    prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: subjectId, resource_type: 'domain', resource_id: domainId,
        permission_id: readPermId, effect, granted_by: ownerId, expires_at: expiresAt,
      },
    });

  /** 워커를 한 틱 돌린다 (@Interval 대신 테스트가 직접 구동해 결정적으로 만든다) */
  const drainWorker = () => verification.processPending();

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    const audit = new AuditService();
    dns = new FakeResolver();
    domains = new DomainsService(p, audit, new ResourceGrantService(audit), new PrismaGrantStore(p));
    verification = new DomainVerificationService(p, audit, dns);
    authz = new AuthorizationService(new PrismaGrantStore(p));
    loader = new ResourceLoaderRegistry(p);

    await prisma.tenant.upsert({
      where: { id: TENANT }, update: {}, create: { id: TENANT, name: `t-${uid()}` },
    });
    const owner = await prisma.user.create({
      data: { tenant_id: TENANT, email: `own-${uid()}@t.local`, password_hash: 'x', name: '소유자', status: 'ACTIVE' },
    });
    const viewer = await prisma.user.create({
      data: { tenant_id: TENANT, email: `vw-${uid()}@t.local`, password_hash: 'x', name: '수임자', status: 'ACTIVE' },
    });
    const perm = await prisma.permission.upsert({
      where: { code: 'domain.read' }, update: {},
      create: { code: 'domain.read', description: '소유 도메인 조회', scope: 'owned' },
    });
    ownerId = owner.id; viewerId = viewer.id; readPermId = perm.id;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.domainVerificationAttempt.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domain.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    dns.records.clear();
    dns.hang = false;
    dns.calls = 0;
  });

  // ── DOM-2 등록 ──────────────────────────────────────────────
  it('DOM-2: 등록은 정규형으로 저장되고 UNVERIFIED + 토큰이 발급된다', async () => {
    const created = await domains.create(snapshot(ownerId), '  EXAMPLE-Reg.COM. ');
    expect(created.fqdn).toBe('example-reg.com');
    expect(created.status).toBe('UNVERIFIED');
    expect(created.verificationRecord?.value).toMatch(/^stonex-site-verification=/);

    // 표기만 다른 같은 도메인은 중복으로 거부된다 — 정규화가 없으면 여기가 통과해 버린다
    await expect(domains.create(snapshot(ownerId), 'Example-Reg.com')).rejects.toMatchObject({ status: 409 });
  });

  it('DOM-7 이후 같은 FQDN 을 재등록할 수 있다 (부분 유니크)', async () => {
    const fqdn = `reuse-${uid()}.example.com`;
    const first = await domains.create(snapshot(ownerId), fqdn);
    await domains.softDelete(snapshot(ownerId), first.id);

    // 전체 유니크였다면 삭제된 행이 슬롯을 점유해 영원히 재등록할 수 없다
    const second = await domains.create(snapshot(ownerId), fqdn);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('UNVERIFIED');
  });

  it('검증 토큰은 추측 불가능하고 도메인마다 다르다', async () => {
    const a = await makeDomain(ownerId);
    const b = await makeDomain(ownerId);
    const rowA = await rowOf(a.id);
    const rowB = await rowOf(b.id);
    expect(rowA.verify_token).not.toBe(rowB.verify_token);
    // 32바이트 난수의 base64url 표현
    expect(rowA.verify_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // ── DOM-3 검증 ──────────────────────────────────────────────
  it('DOM-3: TXT 가 일치하면 VERIFIED 로 전환되고 토큰이 폐기된다(재사용 방지)', async () => {
    const domain = await makeDomain(ownerId);
    const row = await rowOf(domain.id);
    dns.records.set(`_stonex-challenge.${row.fqdn}`, [txtRecordValue(row.verify_token!)]);

    const { state } = await verification.request(snapshot(ownerId), domain.id);
    expect(state).toBe('PENDING'); // API 는 잡만 적재한다
    expect(dns.calls).toBe(0); // 요청 스레드에서 DNS 를 때리지 않는다

    expect(await drainWorker()).toBe(1);
    const after = await rowOf(domain.id);
    expect(after.status).toBe('VERIFIED');
    expect(after.verified_at).not.toBeNull();
    expect(after.verify_token).toBeNull();

    // 성공은 감사에 남는다
    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs WHERE target_id = ${domain.id}::uuid AND action = 'domain.verify'`;
    expect(logs).toHaveLength(1);

    // 폐기된 토큰으로는 다시 검증할 수 없다
    await expect(verification.request(snapshot(ownerId), domain.id)).rejects.toMatchObject({ status: 409 });
  });

  it('DOM-3: TXT 가 없으면 상태가 그대로이고 사유가 시도 테이블에 남는다(감사 로그 오염 방지)', async () => {
    const domain = await makeDomain(ownerId);
    await verification.request(snapshot(ownerId), domain.id);
    await drainWorker();

    const after = await rowOf(domain.id);
    expect(after.status).toBe('UNVERIFIED');
    expect(after.verify_token).not.toBeNull(); // 실패는 토큰을 소모하지 않는다

    const [attempt] = await verification.history(domain.id);
    expect(attempt.state).toBe('FAILED');
    expect(attempt.reason).toContain('TXT');

    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs WHERE target_id = ${domain.id}::uuid AND action = 'domain.verify'`;
    expect(logs).toHaveLength(0); // 실패는 감사 로그에 남기지 않는다
  });

  it('DNS 가 멈춰도 검증 요청 API 는 즉시 반환한다 (워커 미점유)', async () => {
    dns.hang = true;
    const domain = await makeDomain(ownerId);

    const started = Date.now();
    const { attemptId } = await verification.request(snapshot(ownerId), domain.id);
    const elapsed = Date.now() - started;

    // 동기 구현이었다면 여기서 리졸버 타임아웃(3초)만큼 붙잡혀 있었을 것이다
    expect(elapsed).toBeLessThan(3000);
    const [attempt] = await verification.history(domain.id);
    expect(attempt.id).toBe(attemptId);
    expect(attempt.state).toBe('PENDING');
  });

  it('진행 중인 검증이 있으면 같은 시도를 돌려준다 (요청 폭주가 워커 포화로 이어지지 않는다)', async () => {
    const domain = await makeDomain(ownerId);
    const first = await verification.request(snapshot(ownerId), domain.id);
    const second = await verification.request(snapshot(ownerId), domain.id);
    expect(second.attemptId).toBe(first.attemptId);
    expect(await prisma.domainVerificationAttempt.count({ where: { domain_id: domain.id } })).toBe(1);
  });

  it('직전 시도 직후 재요청은 쿨다운에 걸린다 (429)', async () => {
    const domain = await makeDomain(ownerId);
    await verification.request(snapshot(ownerId), domain.id);
    await drainWorker(); // 진행 중 상태를 해소해 멱등 경로를 지난다
    await expect(verification.request(snapshot(ownerId), domain.id)).rejects.toMatchObject({ status: 429 });
  });

  // ── DOM-4 수정 ──────────────────────────────────────────────
  it('DOM-4: FQDN 을 바꾸면 검증이 무효화되고 토큰이 재발급된다', async () => {
    const domain = await makeDomain(ownerId);
    const before = await rowOf(domain.id);
    dns.records.set(`_stonex-challenge.${before.fqdn}`, [txtRecordValue(before.verify_token!)]);
    await verification.request(snapshot(ownerId), domain.id);
    await drainWorker();
    expect((await rowOf(domain.id)).status).toBe('VERIFIED');

    // 검증 상태를 유지한 채 이름만 갈아끼울 수 있으면 검증 절차 전체가 우회된다
    const updated = await domains.update(snapshot(ownerId), domain.id, `moved-${uid()}.example.com`);
    expect(updated.status).toBe('UNVERIFIED');
    const after = await rowOf(domain.id);
    expect(after.verified_at).toBeNull();
    expect(after.verify_token).not.toBeNull();
    expect(after.verify_token).not.toBe(before.verify_token);
  });

  // ── 권한 경로 ────────────────────────────────────────────────
  it('SUSPENDED 도메인은 조회만 되고 수정·검증·삭제는 1단계에서 거부된다 (§4.7 readExtra)', async () => {
    const domain = await makeDomain(ownerId);
    await prisma.domain.update({ where: { id: domain.id }, data: { status: 'SUSPENDED' } });
    const ref = await loader.load('domain', domain.id);

    const read = await authz.can(snapshot(ownerId), 'domain.read', ref);
    expect({ allow: read.allow, step: read.step }).toEqual({ allow: true, step: 3 });

    for (const code of ['domain.update', 'domain.verify', 'domain.delete']) {
      const decision = await authz.can(snapshot(ownerId), code, ref);
      expect({ code, allow: decision.allow, step: decision.step })
        .toEqual({ code, allow: false, step: 1 });
    }
    // 관리자 경로도 예외가 아니다 — readExtra 는 read 계열에만 열려 있다
    const adminUpdate = await authz.can(
      snapshot(viewerId, [['domain.update.all', 'global']]), 'domain.update.all', ref,
    );
    expect(adminUpdate.step).toBe(1);
  });

  it('DOM-7: 소프트 삭제는 status·deleted_at 을 동시에 설정하고 접근이 1단계에서 차단된다', async () => {
    const domain = await makeDomain(ownerId);
    await makeGrant(viewerId, domain.id, 'ALLOW');
    await domains.softDelete(snapshot(ownerId), domain.id);

    const after = await rowOf(domain.id);
    expect(after.status).toBe('DELETED');
    expect(after.deleted_at).not.toBeNull();
    expect(after.verify_token).toBeNull();

    const decision = await authz.can(snapshot(ownerId), 'domain.read', {
      type: 'domain', id: domain.id, ownerId, status: after.status, tenantId: TENANT,
    });
    expect({ allow: decision.allow, step: decision.step }).toEqual({ allow: false, step: 1 });
    await expect(loader.load('domain', domain.id)).rejects.toMatchObject({ status: 404 });

    // Grant 동반 정리 + 그 정리가 감사에 남는다
    expect(await prisma.resourceGrant.count({ where: { resource_id: domain.id } })).toBe(0);
    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs WHERE target_id = ${domain.id}::uuid AND action = 'grant.cleanup'`;
    expect(logs).toHaveLength(1);
  });

  it('삭제는 진행 중인 검증 잡도 종료시킨다 (재등록 후 첫 검증이 막히지 않도록)', async () => {
    const domain = await makeDomain(ownerId);
    await verification.request(snapshot(ownerId), domain.id);
    await domains.softDelete(snapshot(ownerId), domain.id);

    const [attempt] = await verification.history(domain.id);
    expect(attempt.state).toBe('FAILED');
    // 워커가 집을 잡이 남아 있지 않다
    expect(await drainWorker()).toBe(0);
  });

  it('Grant 수임자는 허용되고 무관한 제3자는 거부된다', async () => {
    const domain = await makeDomain(ownerId);
    const ref = await loader.load('domain', domain.id);
    const stranger = snapshot(viewerId, MEMBER_PERMS);

    const before = await authz.can(stranger, 'domain.read', ref);
    expect({ allow: before.allow, step: before.step }).toEqual({ allow: false, step: 5 });

    await makeGrant(viewerId, domain.id, 'ALLOW');
    const after = await authz.can(stranger, 'domain.read', ref);
    expect({ allow: after.allow, step: after.step }).toEqual({ allow: true, step: 4 });
  });

  it('이전받은 MEMBER 는 자기 도메인을 수정·검증·삭제할 수 있다 (기획서 v1.7 §4.5)', async () => {
    // 등록은 domain.create(global)가 필요하지만, 이전받은 뒤에는 owned 권한만으로 운영할 수 있어야 한다
    const domain = await makeDomain(ownerId);
    await prisma.domain.update({ where: { id: domain.id }, data: { owner_id: viewerId } });
    const ref = await loader.load('domain', domain.id);
    const member = snapshot(viewerId, MEMBER_PERMS);

    for (const code of ['domain.update', 'domain.verify', 'domain.delete', 'domain.transfer', 'domain.share']) {
      const decision = await authz.can(member, code, ref);
      expect({ code, allow: decision.allow, step: decision.step }).toEqual({ code, allow: true, step: 3 });
    }
    // 시드의 MEMBER 매핑에도 실제로 들어 있어야 한다 — 여기가 어긋나면 실물 DB 에서만 실패한다
    const seedMember = ROLES.find((r) => r.code === 'MEMBER')!.permissions;
    for (const code of ['domain.update', 'domain.verify', 'domain.delete', 'domain.transfer', 'domain.share']) {
      expect(seedMember).toContain(code);
    }
  });

  // ── 컬렉션 등가성 ────────────────────────────────────────────
  describe('컬렉션 등가성 (기획서 §7.3-2, RT-22)', () => {
    it('목록의 모든 항목이 개별 can() 에서 ALLOW 이고, 제외 픽스처가 목록에 없다', async () => {
      const lister = snapshot(viewerId, MEMBER_PERMS);

      const ownActive = await makeDomain(viewerId);
      const ownSuspended = await makeDomain(viewerId);
      await prisma.domain.update({ where: { id: ownSuspended.id }, data: { status: 'SUSPENDED' } });
      const ownDeleted = await makeDomain(viewerId);
      await domains.softDelete(snapshot(viewerId), ownDeleted.id);

      const sharedAllow = await makeDomain(ownerId);
      await makeGrant(viewerId, sharedAllow.id, 'ALLOW');

      const sharedDeny = await makeDomain(ownerId);
      await prisma.resourceGrant.create({
        data: {
          tenant_id: TENANT, subject_id: viewerId, resource_type: 'domain', resource_id: sharedDeny.id,
          permission_id: readPermId, effect: 'DENY', granted_by: ownerId,
        },
      });

      const sharedExpired = await makeDomain(ownerId);
      await makeGrant(viewerId, sharedExpired.id, 'ALLOW', new Date(Date.now() - 1000));

      const { items } = await domains.listVisible(lister, 1, 100);
      const ids = new Set(items.map((i) => i.id));

      expect(ids.has(ownActive.id)).toBe(true);
      expect(ids.has(sharedAllow.id)).toBe(true);
      // **SUSPENDED 는 목록에 남아야 한다** — 조회는 readExtra 로 허용되므로,
      // 빼면 "상세는 보이는데 목록엔 없는" 불일치가 된다(파일 목록과 다른 지점)
      expect(ids.has(ownSuspended.id)).toBe(true);

      expect(ids.has(ownDeleted.id)).toBe(false); // 1단계
      expect(ids.has(sharedDeny.id)).toBe(false); // 2단계(INV-4)
      expect(ids.has(sharedExpired.id)).toBe(false); // 4단계(만료)

      for (const item of items) {
        const row = await rowOf(item.id);
        const decision = await authz.can(lister, 'domain.read', {
          type: 'domain', id: row.id, ownerId: row.owner_id, status: row.status, tenantId: row.tenant_id,
        });
        expect({ id: row.id, allow: decision.allow }).toEqual({ id: row.id, allow: true });
      }
    });
  });
});
