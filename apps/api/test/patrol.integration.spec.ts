/**
 * WP-14a 통합 테스트 (실 DB) — 런타임 불변식 순찰.
 *
 * DoD:
 *  - RI-1~RI-8 각각에 대해 위반을 인위적으로 만들고 순찰이 검출함 (8건 전부)
 *  - L-1 자동 회수 + 회수 전 행 내용이 감사에 남아 복구 가능
 *  - blast-radius 상한 초과 시 자동 조치 중단 + 승격
 *  - 미등록 리소스 타입이 "위반"이 아니라 "검사 불가"로 분류
 *  - fail-open 검증: 화이트리스트가 비면 조용히 통과하지 않는다
 *  - 복제본 2개를 기동해도 한 주기에 1회만 실행되고 감사 기록도 1건
 *  - 순찰 실패가 'ok' 로 접히지 않고 'failed' 로 구분된다
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { GovernancePatrolService } from '../src/governance/patrol.service';
import { AuditCheckpointService } from '../src/governance/checkpoint.service';
import { GovernanceAlert, GovernanceNotifier } from '../src/governance/notifier';
import { PATROL_LOCK_KEY } from '../src/governance/patrol.service';
import { assertContextUsable, buildContext } from '../src/governance/invariant.registry';
import { DEFAULT_TENANT_ID, PERMISSIONS, ROLES } from '../../../db/seeds/permissions';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009984';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

class CollectingNotifier implements GovernanceNotifier {
  alerts: GovernanceAlert[] = [];
  async send(alert: GovernanceAlert): Promise<void> {
    this.alerts.push(alert);
  }
  reset(): void {
    this.alerts = [];
  }
}

describe('WP-14a 런타임 불변식 순찰 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let patrol: GovernancePatrolService;
  let checkpoints: AuditCheckpointService;
  let notifier: CollectingNotifier;
  let ownerId: string;
  let otherId: string;
  const permIds: Record<string, string> = {};
  const roleIds: Record<string, string> = {};

  /** 특정 RI 의 결과만 꺼낸다 */
  const check = (result: Awaited<ReturnType<GovernancePatrolService['patrol']>>, id: string) =>
    result.checks.find((c) => c.id === id)!;

  const makeUser = async (label: string, status = 'ACTIVE') =>
    prisma.user.create({
      data: {
        tenant_id: TENANT, email: `${label}-${uid()}@t.local`, password_hash: 'x',
        name: label, status,
      },
    });

  const makeFile = async (owner: string) =>
    prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: owner, name: `f-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });

  const makeGrant = async (
    subjectId: string, resourceId: string, code = 'file.read',
    overrides: Record<string, unknown> = {},
  ) =>
    prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: subjectId, resource_type: 'file', resource_id: resourceId,
        permission_id: permIds[code], effect: 'ALLOW', granted_by: ownerId, ...overrides,
      },
    });

  /**
   * 순찰이 남긴 잔여 상태를 씻어낸다 — 스펙 간 위반이 새어나가지 않도록.
   * **부여자 기준도 함께 본다**: RI-5 테스트가 Grant 의 tenant_id 를 일부러 어긋나게 만들므로,
   * 테넌트만으로 지우면 그 행이 남아 사용자 삭제가 FK 로 막힌다.
   */
  const cleanGrants = () =>
    prisma.resourceGrant.deleteMany({
      where: { OR: [{ tenant_id: TENANT }, { granted_by: ownerId }] },
    });

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;

    const audit = new AuditService();
    notifier = new CollectingNotifier();
    patrol = new GovernancePatrolService(p, audit, new ResourceGrantService(audit), new PrismaGrantStore(p), notifier);
    checkpoints = new AuditCheckpointService(p);

    // 기본 테넌트는 RI-1·RI-6 이 전 테넌트를 훑으므로 반드시 정상 상태여야 한다
    await prisma.tenant.upsert({
      where: { id: DEFAULT_TENANT_ID }, update: {}, create: { id: DEFAULT_TENANT_ID, name: 'default' },
    });
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
        update: { is_system: r.isSystem },
        create: {
          tenant_id: TENANT, code: r.code, name: r.name,
          display_order: r.displayOrder, requires_2fa: r.requires2fa, is_system: r.isSystem,
        },
      });
      roleIds[r.code] = role.id;
    }

    ownerId = (await makeUser('owner')).id;
    otherId = (await makeUser('other')).id;
    // 이 테넌트에 활성 SUPER_ADMIN 을 둬 RI-1 기본 상태를 정상으로 만든다
    await prisma.userRole.create({
      data: { tenant_id: TENANT, user_id: ownerId, role_id: roleIds['SUPER_ADMIN'] },
    });
    // 부여자가 file.share 를 실제로 보유하게 해 RI-8 기본 상태를 정상으로 만든다
    await prisma.rolePermission.upsert({
      where: { role_id_permission_id: { role_id: roleIds['SUPER_ADMIN'], permission_id: permIds['file.share'] } },
      update: {},
      create: { tenant_id: TENANT, role_id: roleIds['SUPER_ADMIN'], permission_id: permIds['file.share'] },
    });
    for (const code of ['file.share.all', 'domain.share.all']) {
      await prisma.rolePermission.upsert({
        where: { role_id_permission_id: { role_id: roleIds['SUPER_ADMIN'], permission_id: permIds[code] } },
        update: {},
        create: { tenant_id: TENANT, role_id: roleIds['SUPER_ADMIN'], permission_id: permIds[code] },
      });
    }
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid AND action = 'governance.patrol'`;
    await prisma.resourceGrant.deleteMany({
      where: { OR: [{ tenant_id: TENANT }, { granted_by: ownerId }] },
    });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.rolePermission.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(() => notifier.reset());

  it('위반이 없으면 8종 전부 ok 로 판정되고, 실행 자체가 감사에 남는다 (§14.4 — 감시자도 감사 대상)', async () => {
    const result = await patrol.patrol();
    expect(result.checks).toHaveLength(8);
    const failed = result.checks.filter((c) => c.status === 'failed');
    // **'검사 실패'가 하나도 없어야 한다** — SQL 오류·바인딩 실수는 여기서 드러난다.
    // 반면 "위반 0건"은 단언하지 않는다: 불변식은 전 테넌트를 훑고 jest 는 스펙 파일을
    // 병렬 실행하므로, 다른 스펙이 만드는 일시적 상태가 그대로 위반으로 잡힌다.
    // 검출 능력은 아래 RI별 테스트가 자기 픽스처를 지목해 확인한다.
    expect(failed.map((c) => `${c.id}: ${c.error}`)).toEqual([]);

    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs
       WHERE action = 'governance.patrol' AND created_at > now() - interval '1 minute'`;
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  // ── RI별 검출 실증 ────────────────────────────────────────────
  it('RI-1: 활성 SUPER_ADMIN 이 없는 테넌트를 검출한다 (부재가 위반인 존재형)', async () => {
    const lonely = '00000000-0000-0000-0000-0000000099f1';
    await prisma.tenant.upsert({
      where: { id: lonely }, update: {}, create: { id: lonely, name: 'lonely' },
    });
    try {
      const result = await patrol.patrol();
      const ri1 = check(result, 'RI-1');
      expect(ri1.status).toBe('violated');
      expect(ri1.violations.map((v) => v.subject)).toContain(lonely);
      // 자동 조치 대상이 아니며 즉시 호출 알림에 런북 경로가 실린다
      expect(notifier.alerts.some((a) => a.level === 'PAGE' && a.title.includes('RI-1'))).toBe(true);
    } finally {
      await prisma.tenant.delete({ where: { id: lonely } });
    }
  });

  it('RI-2: 자기 자신에게 역할을 부여한 행을 검출한다', async () => {
    await prisma.userRole.create({
      data: {
        tenant_id: TENANT, user_id: otherId, role_id: roleIds['MEMBER'], granted_by: otherId,
      },
    });
    try {
      const ri2 = check(await patrol.patrol(), 'RI-2');
      expect(ri2.status).toBe('violated');
      expect(ri2.violations[0].subject).toBe(otherId);
      expect(notifier.alerts.some((a) => a.level === 'L2')).toBe(true);
    } finally {
      await prisma.userRole.deleteMany({ where: { user_id: otherId } });
    }
  });

  it('RI-3: 화이트리스트 밖 ALLOW Grant 를 검출하고 L-1 로 회수한다 (DENY 는 대상 아님)', async () => {
    const file = await makeFile(ownerId);
    // file.delete 는 §4.4 화이트리스트에 없다
    const bad = await makeGrant(otherId, file.id, 'file.delete');
    // DENY 는 §9.6 차단 수단이라 회수 대상이 아니다(WT-27)
    const deny = await makeGrant(otherId, file.id, 'file.update', { effect: 'DENY' });
    try {
      const result = await patrol.patrol();
      const ri3 = check(result, 'RI-3');
      expect(ri3.status).toBe('violated');
      expect(ri3.violations.map((v) => v.subject)).toEqual([bad.id]);
      expect(result.remediated).toBeGreaterThanOrEqual(1);

      // 회수됐고, DENY 는 남았다
      expect(await prisma.resourceGrant.findUnique({ where: { id: bad.id } })).toBeNull();
      expect(await prisma.resourceGrant.findUnique({ where: { id: deny.id } })).not.toBeNull();

      // 회수 전 행 전체가 감사에 남아 복구 가능하다
      const [log] = await prisma.$queryRaw<Array<{ detail: { before: Record<string, unknown>; reason?: string } }>>`
        SELECT detail FROM audit.audit_logs
         WHERE action = 'grant.revoke' AND target_id = ${file.id}::uuid
         ORDER BY created_at DESC LIMIT 1`;
      expect(log.detail.before).toMatchObject({
        id: bad.id, subject: otherId, resourceType: 'file', effect: 'ALLOW',
      });
      expect(log.detail.reason).toContain('RI-3');
    } finally {
      await cleanGrants();
    }
  });

  it('RI-4: 소프트 삭제된 리소스의 Grant 를 고아로 검출하고 회수한다', async () => {
    const file = await makeFile(ownerId);
    const grant = await makeGrant(otherId, file.id);
    await prisma.file.update({
      where: { id: file.id }, data: { status: 'DELETED', deleted_at: new Date() },
    });
    try {
      const ri4 = check(await patrol.patrol(), 'RI-4');
      expect(ri4.status).toBe('violated');
      expect(ri4.violations[0].detail.reason).toBe('resource_deleted');
      expect(await prisma.resourceGrant.findUnique({ where: { id: grant.id } })).toBeNull();
    } finally {
      await cleanGrants();
    }
  });

  it('RI-5: Grant 의 테넌트가 리소스와 어긋나면 검출한다', async () => {
    const file = await makeFile(ownerId);
    const grant = await makeGrant(otherId, file.id);
    await prisma.$executeRaw`
      UPDATE resource_grants SET tenant_id = ${DEFAULT_TENANT_ID}::uuid WHERE id = ${grant.id}::uuid`;
    try {
      const ri5 = check(await patrol.patrol(), 'RI-5');
      expect(ri5.status).toBe('violated');
      expect(ri5.violations.map((v) => v.subject)).toContain(grant.id);
    } finally {
      await cleanGrants();
    }
  });

  it('RI-6: 시스템 역할의 is_system 이 꺼지면 검출한다', async () => {
    await prisma.role.update({ where: { id: roleIds['MEMBER'] }, data: { is_system: false } });
    try {
      const ri6 = check(await patrol.patrol(), 'RI-6');
      expect(ri6.status).toBe('violated');
      expect(ri6.violations.some((v) => v.detail.kind === 'flag_cleared')).toBe(true);
      expect(notifier.alerts.some((a) => a.level === 'PAGE' && a.title.includes('RI-6'))).toBe(true);
    } finally {
      await prisma.role.update({ where: { id: roleIds['MEMBER'] }, data: { is_system: true } });
    }
  });

  it('RI-7: 체크포인트 이후 감사 로그가 변조되면 검출한다', async () => {
    // 어제 날짜로 로그 1건을 심고 체크포인트를 찍는다
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const day = yesterday.toISOString().slice(0, 10);
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit.audit_logs (tenant_id, action, detail, created_at)
       VALUES ($1::uuid, 'test.checkpoint', '{"n":1}'::jsonb, $2::timestamptz)`,
      TENANT, `${day}T09:00:00Z`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM audit.audit_checkpoints WHERE period_date = $1::date`, day);
    expect(await checkpoints.checkpoint(yesterday)).toBe(true);

    // 체크포인트 직후에는 정상
    expect(check(await patrol.patrol(), 'RI-7').status).toBe('ok');

    try {
      // 봉인된 구간의 로그를 지운다 (append-only 를 우회한 상황을 재현)
      await prisma.$executeRawUnsafe(
        `DELETE FROM audit.audit_logs WHERE tenant_id = $1::uuid AND action = 'test.checkpoint'`,
        TENANT,
      );
      const ri7 = check(await patrol.patrol(), 'RI-7');
      expect(ri7.status).toBe('violated');
      expect(ri7.violations[0].detail.kind).toBe('day_hash_mismatch');
      // 자동 조치 대상이 아니라 보고(L-3)다
      expect(notifier.alerts.some((a) => a.level === 'L3' && a.title.includes('RI-7'))).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe(`DELETE FROM audit.audit_checkpoints WHERE period_date = $1::date`, day);
    }
  });

  it('RI-8: 부여자가 share 권한을 잃으면 권한 화석으로 검출한다 (자동 회수는 하지 않는다)', async () => {
    const file = await makeFile(ownerId);
    const grant = await makeGrant(otherId, file.id);
    // 부여자에게서 file.share·file.share.all 을 회수 → 지금은 이 Grant 를 만들 수 없다
    await prisma.rolePermission.deleteMany({
      where: {
        role_id: roleIds['SUPER_ADMIN'],
        permission_id: { in: [permIds['file.share'], permIds['file.share.all']] },
      },
    });
    try {
      const result = await patrol.patrol();
      const ri8 = check(result, 'RI-8');
      expect(ri8.status).toBe('violated');
      expect(ri8.violations.map((v) => v.subject)).toContain(grant.id);
      // L-3 이므로 Grant 는 그대로 살아 있어야 한다 — 자동 삭제하면 관리자 교체 때마다
      // 정상 공유가 대량으로 끊긴다
      expect(await prisma.resourceGrant.findUnique({ where: { id: grant.id } })).not.toBeNull();
    } finally {
      for (const code of ['file.share', 'file.share.all']) {
        await prisma.rolePermission.upsert({
          where: { role_id_permission_id: { role_id: roleIds['SUPER_ADMIN'], permission_id: permIds[code] } },
          update: {},
          create: { tenant_id: TENANT, role_id: roleIds['SUPER_ADMIN'], permission_id: permIds[code] },
        });
      }
      await cleanGrants();
    }
  });

  // ── 대응 정책 ─────────────────────────────────────────────────
  it('조치 대상이 상한을 넘으면 자동 조치를 중단하고 승격한다 (WT-11)', async () => {
    const file = await makeFile(ownerId);
    const cap = Number(process.env.PATROL_BLAST_RADIUS_ROWS ?? 20);
    const subjects: string[] = [];
    for (let i = 0; i < cap + 1; i += 1) subjects.push((await makeUser(`bulk${i}`)).id);
    for (const s of subjects) await makeGrant(s, file.id, 'file.delete');

    try {
      const result = await patrol.patrol();
      expect(result.escalated).toContain('RI-3');
      expect(result.remediated).toBe(0);
      // 한 건도 지우지 않았다 — 대량 위반은 정의가 어긋났다는 신호이지 데이터 이상이 아니다
      expect(await prisma.resourceGrant.count({ where: { resource_id: file.id } })).toBe(cap + 1);
      expect(notifier.alerts.some((a) => a.level === 'L2' && a.title.includes('상한'))).toBe(true);
    } finally {
      await cleanGrants();
    }
  });

  it('미등록 리소스 타입은 위반이 아니라 "검사 불가"로 분류된다 (신규 모듈 전량 삭제 방지)', async () => {
    const file = await makeFile(ownerId);
    // §9.1 로 추가될 신규 모듈의 정상 Grant 를 흉내 낸다
    await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: otherId, resource_type: 'board.post',
        resource_id: file.id, permission_id: permIds['file.read'], effect: 'ALLOW', granted_by: ownerId,
      },
    });
    try {
      const result = await patrol.patrol();
      expect(result.unknownResourceTypes).toContain('board.post');
      expect(check(result, 'RI-3').status).toBe('ok');
      expect(check(result, 'RI-4').status).toBe('ok');
      // 살아 있어야 한다
      expect(await prisma.resourceGrant.count({ where: { resource_type: 'board.post' } })).toBe(1);
      expect(notifier.alerts.some((a) => a.level === 'L3' && a.title.includes('검사 불가'))).toBe(true);
    } finally {
      await cleanGrants();
    }
  });

  it('화이트리스트가 비면 조용히 통과하지 않고 검사 불가로 끊긴다 (fail-open 차단)', () => {
    const ctx = buildContext();
    expect(() => assertContextUsable(ctx)).not.toThrow();
    expect(() => assertContextUsable({ ...ctx, grantWhitelist: {} })).toThrow(/검사 불가/);
    expect(() => assertContextUsable({ ...ctx, grantWhitelist: { file: [] } })).toThrow(/검사 불가/);
    expect(() => assertContextUsable({ ...ctx, systemRoles: [] })).toThrow(/검사 불가/);
  });

  it('불변식 SQL 이 없으면 "검사 실패"로 구분되고 ok 로 접히지 않는다 (RT-20)', async () => {
    const audit = new AuditService();
    const broken = new GovernancePatrolService(p, audit, new ResourceGrantService(audit), new PrismaGrantStore(p), notifier);
    // 파일명을 존재하지 않는 것으로 바꿔 실패를 주입한다
    const registry = await import('../src/governance/invariant.registry');
    const target = registry.INVARIANTS.find((i) => i.id === 'RI-2')!;
    const original = target.file;
    target.file = 'ri-2-does-not-exist.sql';
    try {
      const result = await broken.patrol();
      const ri2 = check(result, 'RI-2');
      expect(ri2.status).toBe('failed');
      expect(ri2.error).toContain('ri-2-does-not-exist.sql');
      // 다른 검사는 계속 수행된다 — 한 건의 실패가 순찰 전체를 마비시키지 않는다.
      // (다른 스펙이 만드는 일시적 위반 때문에 'ok' 개수는 단언하지 않고, **실패한 것이
      //  RI-2 하나뿐**임을 본다 — 저장점 격리가 무너지면 여기가 즉시 깨진다)
      expect(result.checks.filter((c) => c.status === 'failed').map((c) => c.id)).toEqual(['RI-2']);
      expect(result.checks).toHaveLength(8);
      expect(notifier.alerts.some((a) => a.level === 'PAGE' && a.title.includes('검사 실패'))).toBe(true);
    } finally {
      target.file = original;
    }
  });

  it('만료 Grant 정리 배치는 만료분만 지우고 감사에 남긴다 (고아 정리와 역할이 겹치지 않는다)', async () => {
    const file = await makeFile(ownerId);
    const expired = await makeGrant(otherId, file.id, 'file.read', {
      expires_at: new Date(Date.now() - 60_000),
    });
    const alive = await makeGrant(ownerId, file.id, 'file.update');
    try {
      const purged = await patrol.purgeExpiredGrants();
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(await prisma.resourceGrant.findUnique({ where: { id: expired.id } })).toBeNull();
      expect(await prisma.resourceGrant.findUnique({ where: { id: alive.id } })).not.toBeNull();

      const [log] = await prisma.$queryRaw<Array<{ detail: { reason?: string } }>>`
        SELECT detail FROM audit.audit_logs
         WHERE action = 'grant.revoke' AND target_id = ${file.id}::uuid
         ORDER BY created_at DESC LIMIT 1`;
      expect(log.detail.reason).toContain('만료');
    } finally {
      await cleanGrants();
    }
  });

  it('다른 인스턴스가 순찰 중이면 그 주기를 건너뛴다 (advisory lock — 감사도 남기지 않는다)', async () => {
    // 두 인스턴스를 동시에 띄우는 방식은 **경합이 실제로 겹칠 때만** 유효해 CI 에서 흔들린다.
    // 여기서는 잠금을 쥔 트랜잭션 **안에서** 다른 클라이언트의 순찰을 호출해 결정적으로 만든다.
    const replicaClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    const audit = new AuditService();
    const replica = new GovernancePatrolService(
      replicaClient as unknown as PrismaService, audit,
      new ResourceGrantService(audit), new PrismaGrantStore(replicaClient as unknown as PrismaService),
      notifier,
    );

    await prisma.$executeRaw`DELETE FROM audit.audit_logs
      WHERE action = 'governance.patrol' AND created_at > now() - interval '5 minutes'`;
    try {
      await prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
          `SELECT pg_try_advisory_xact_lock(${PATROL_LOCK_KEY}) AS locked`,
        );
        expect(row.locked).toBe(true); // 이 트랜잭션이 잠금을 쥔다

        const result = await replica.patrol();
        expect(result.skipped).toBe('lock');
        expect(result.checks).toEqual([]);
      }, { timeout: 60_000 });

      // 건너뛴 주기는 감사에도 남지 않는다 — 남기면 "돌았는데 이상 없었다"로 오독된다
      const logs = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM audit.audit_logs
         WHERE action = 'governance.patrol' AND created_at > now() - interval '5 minutes'`;
      expect(Number(logs[0].n)).toBe(0);
    } finally {
      await replicaClient.$disconnect();
    }
  });
});
