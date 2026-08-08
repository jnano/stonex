/**
 * WP-14b 통합 테스트 (실 DB) — L-2 동결 · 거버넌스 API · 이상 탐지.
 *
 * DoD:
 *  - 동결이 **권한 변경만** 막고 일반 서비스 이용은 유지한다
 *  - **피동결자 본인의 해제 승인이 거부**된다
 *  - 승인 가능한 활성 SUPER_ADMIN 이 0명이면 break-glass 로 안내된다
 *  - `governance.read` 미보유 계정의 거버넌스 API 접근이 거부된다 (RT-20)
 *  - 순찰 **실패**가 대시보드에 "검사 실패"로 구분 표시된다 (정상으로 오인 금지 — RT-20)
 *  - 이상 탐지 규칙이 정황을 신호로 올리되 자동 동결하지 않는다
 */
import { INVARIANTS } from '../src/governance/invariant.registry';
import { testRegistry } from './helpers/registry';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { GovernanceFreezeService, FROZEN_PERMISSIONS } from '../src/governance/freeze.service';
import { GovernancePatrolService } from '../src/governance/patrol.service';
import { GovernanceStatusService } from '../src/governance/governance.service';
import { AnomalyDetectionService } from '../src/governance/anomaly.service';
import { GovernanceAlert, GovernanceNotifier } from '../src/governance/notifier';
import { PermissionScope, SubjectSnapshot } from '../src/authorization/types';
import { DEFAULT_TENANT_ID, PERMISSIONS, ROLES } from '../../../db/seeds/permissions';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009983';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

class CollectingNotifier implements GovernanceNotifier {
  alerts: GovernanceAlert[] = [];
  async send(alert: GovernanceAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

describe('WP-14b L-2 동결 · 거버넌스 API (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let freezes: GovernanceFreezeService;
  let grants: ResourceGrantService;
  let statusService: GovernanceStatusService;
  let anomalies: AnomalyDetectionService;
  let notifier: CollectingNotifier;
  let ownerId: string;
  let adminId: string;
  let otherAdminId: string;
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
    notifier = new CollectingNotifier();
    freezes = new GovernanceFreezeService(p, audit);
    grants = new ResourceGrantService(audit, freezes, testRegistry(p));
    const patrol = new GovernancePatrolService(p, audit, grants, new PrismaGrantStore(p), notifier);
    statusService = new GovernanceStatusService(p, patrol);
    anomalies = new AnomalyDetectionService(p, freezes, notifier);

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
    }

    ownerId = (await makeUser('owner')).id;
    adminId = (await makeUser('admin')).id;
    otherAdminId = (await makeUser('other-admin')).id;
    for (const id of [adminId, otherAdminId]) {
      await prisma.userRole.create({
        data: { tenant_id: TENANT, user_id: id, role_id: roleIds['SUPER_ADMIN'] },
      });
    }
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.governanceFreeze.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.resourceGrant.deleteMany({
      where: { OR: [{ tenant_id: TENANT }, { granted_by: ownerId }] },
    });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.governanceFreeze.deleteMany({ where: { tenant_id: TENANT } });
  });

  // ── 동결 대상 정의 ────────────────────────────────────────────
  it('동결 대상은 라우트가 아니라 Permission 집합으로 정의된다 (신규 API 누락 방지)', () => {
    // 권한을 옮기는 코드
    for (const code of [
      'file.share', 'file.share.all', 'domain.share', 'domain.share.all',
      'member.role.assign', 'admin.role.manage',
    ]) {
      expect(GovernanceFreezeService.isFrozenScope(code)).toBe(true);
    }
    // 자기 리소스를 만들고 쓰는 행위는 대상이 아니다 — 동결은 서비스 이용을 막지 않는다
    for (const code of ['file.upload', 'file.read', 'domain.create', 'domain.update', 'member.read']) {
      expect(GovernanceFreezeService.isFrozenScope(code)).toBe(false);
    }
    // 시드에서 도출되므로 집합이 비는 일이 없어야 한다
    expect(FROZEN_PERMISSIONS.size).toBeGreaterThanOrEqual(6);
  });

  // ── 동결 강제 ─────────────────────────────────────────────────
  it('동결은 권한 변경(Grant 생성)을 막고, 일반 서비스 이용은 유지한다', async () => {
    const file = await makeFile(ownerId);
    await freezes.freeze({
      tenantId: TENANT, userId: ownerId, trigger: 'AN-3', reason: '단시간 대량 Grant 생성', actorId: adminId,
    });

    // 권한 변경은 막힌다 — 사유가 명시된 403 이다(404 은닉 대상이 아니다)
    await expect(
      prisma.$transaction((tx) =>
        grants.create(tx, {
          tenantId: TENANT, actorId: ownerId, subjectId: adminId,
          resourceType: 'file', resourceId: file.id, permissionCodes: ['file.read'],
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });

    // 같은 계정이 자기 파일을 계속 쓰는 것은 막지 않는다
    const updated = await prisma.file.update({ where: { id: file.id }, data: { name: 'still-mine.txt' } });
    expect(updated.name).toBe('still-mine.txt');

    // 동결 자체가 감사에 남는다 (§14.4 — 감시자도 감사 대상)
    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs
       WHERE target_id = ${ownerId}::uuid AND action = 'governance.freeze'`;
    expect(logs).toHaveLength(1);
  });

  it('시스템 행위(순찰의 자동 회수)는 동결 대상이 아니다', async () => {
    const file = await makeFile(ownerId);
    const grant = await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: adminId, resource_type: 'file', resource_id: file.id,
        permission_id: permIds['file.read'], effect: 'ALLOW', granted_by: ownerId,
      },
    });
    await freezes.freeze({
      tenantId: TENANT, userId: ownerId, trigger: 'RI-2', reason: '자기 부여 흔적', actorId: adminId,
    });

    // actorId=null 은 시스템 행위 — 동결하면 이상 상황에서 정리 자체가 멈춘다
    await prisma.$transaction((tx) =>
      grants.revoke(tx, { tenantId: TENANT, actorId: null, grantId: grant.id, reason: 'RI-3 자동 회수' }),
    );
    expect(await prisma.resourceGrant.findUnique({ where: { id: grant.id } })).toBeNull();
  });

  it('활성 동결은 한 사용자에 1건만 쌓인다 (멱등)', async () => {
    const a = await freezes.freeze({
      tenantId: TENANT, userId: ownerId, trigger: 'AN-1', reason: '첫 번째', actorId: adminId,
    });
    const b = await freezes.freeze({
      tenantId: TENANT, userId: ownerId, trigger: 'AN-2', reason: '두 번째', actorId: adminId,
    });
    expect(b.id).toBe(a.id);
    expect(await prisma.governanceFreeze.count({ where: { user_id: ownerId, status: 'ACTIVE' } })).toBe(1);
  });

  // ── 해제 승인 ─────────────────────────────────────────────────
  it('피동결자 본인은 자기 동결을 해제할 수 없다 (§14.4)', async () => {
    const freeze = await freezes.freeze({
      tenantId: TENANT, userId: adminId, trigger: 'AN-1', reason: '비업무 시간 대량 변경', actorId: otherAdminId,
    });
    // 본인이 풀 수 있으면 L-2 는 아무것도 막지 못한다
    await expect(
      freezes.release(snapshot(adminId, [['governance.freeze.manage', 'global']]), freeze.id),
    ).rejects.toMatchObject({ status: 403 });

    const after = await prisma.governanceFreeze.findUniqueOrThrow({ where: { id: freeze.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('다른 활성 SUPER_ADMIN 은 해제할 수 있고 그 기록이 남는다', async () => {
    const freeze = await freezes.freeze({
      tenantId: TENANT, userId: adminId, trigger: 'AN-1', reason: '확인 완료', actorId: otherAdminId,
    });
    const released = await freezes.release(
      snapshot(otherAdminId, [['governance.freeze.manage', 'global']]), freeze.id, '오탐으로 확인',
    );
    expect(released.status).toBe('RELEASED');
    expect(released.releasedBy).toBe(otherAdminId);

    const logs = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs
       WHERE target_id = ${adminId}::uuid AND action = 'governance.freeze.release'`;
    expect(logs).toHaveLength(1);
  });

  it('승인 가능한 활성 SUPER_ADMIN 이 0명이면 break-glass 로 안내된다 (WT-12)', async () => {
    // 다른 관리자를 정지시켜 승인 가능 인원을 0으로 만든다
    await prisma.user.update({ where: { id: otherAdminId }, data: { status: 'SUSPENDED' } });
    const freeze = await freezes.freeze({
      tenantId: TENANT, userId: adminId, trigger: 'RI-5', reason: '교차 테넌트 정황', actorId: null,
    });
    try {
      expect(await freezes.countEligibleApprovers(TENANT, adminId)).toBe(0);
      // 제3자가 시도해도 승인 정족수가 없으므로 런북으로 넘긴다
      await expect(
        freezes.release(snapshot(ownerId, [['governance.freeze.manage', 'global']]), freeze.id),
      ).rejects.toThrow(/break-glass/);
    } finally {
      await prisma.user.update({ where: { id: otherAdminId }, data: { status: 'ACTIVE' } });
    }
  });

  // ── 거버넌스 상태 API ─────────────────────────────────────────
  it('순찰 기록이 없으면 모든 RI 가 unknown 이고 healthy 가 아니다 ("이상 없음"과 구분)', async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE action = 'governance.patrol'`;
    const status = await statusService.status();
    expect(status.healthy).toBe(false);
    expect(status.lastRunAt).toBeNull();
    // 정의된 불변식 8종이 전부 나열되어야 한다 — 빠지면 "검사되지 않는 불변식"이 화면에서 사라진다
    expect(status.checks).toHaveLength(INVARIANTS.length);
    expect(status.checks.every((c) => c.status === 'unknown')).toBe(true);
  });

  it('검사 실패는 대시보드에 "실패"로 구분 표시된다 (정상으로 오인 금지 — RT-20)', async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE action = 'governance.patrol'`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit.audit_logs (tenant_id, action, target_type, detail)
       VALUES ($1::uuid, 'governance.patrol', 'governance', $2::jsonb)`,
      DEFAULT_TENANT_ID,
      JSON.stringify({
        before: {},
        after: {
          durationMs: 12, remediated: 0, escalated: [], unknownResourceTypes: [],
          checks: [
            { id: 'RI-1', status: 'ok', violations: 0 },
            { id: 'RI-3', status: 'failed', violations: 0, error: 'relation "x" does not exist' },
          ],
        },
      }),
    );
    try {
      const status = await statusService.status();
      expect(status.hasFailedChecks).toBe(true);
      const ri3 = status.checks.find((c) => c.id === 'RI-3')!;
      expect(ri3.status).toBe('failed');
      expect(ri3.error).toContain('does not exist');
      // 기록에 없는 RI 는 ok 가 아니라 unknown 이다
      expect(status.checks.find((c) => c.id === 'RI-8')!.status).toBe('unknown');
    } finally {
      await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE action = 'governance.patrol'`;
    }
  });

  it('L-1 조치 이력은 감사에서 파생되며 회수 전 행을 화이트리스트로 추려 내보낸다 (§10.2)', async () => {
    const file = await makeFile(ownerId);
    const grant = await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: adminId, resource_type: 'file', resource_id: file.id,
        permission_id: permIds['file.read'], effect: 'ALLOW', granted_by: ownerId,
      },
    });
    await prisma.$transaction((tx) =>
      grants.revoke(tx, { tenantId: TENANT, actorId: null, grantId: grant.id, reason: 'RI-4 자동 회수' }),
    );

    const actions = await statusService.actions(10);
    const mine = actions.find((a) => a.targetId === file.id)!;
    expect(mine.reason).toContain('RI-4');
    expect(mine.before).toMatchObject({ subject: adminId, resourceType: 'file', effect: 'ALLOW' });
    // 화이트리스트 밖 필드(permissionId·grantedBy 등)는 응답에 실리지 않는다
    expect(Object.keys(mine.before!).sort()).toEqual(['effect', 'resourceId', 'resourceType', 'subject']);
  });

  // ── 이상 탐지 ─────────────────────────────────────────────────
  it('단시간 대량 Grant 생성을 신호로 올리되 자동 동결하지 않는다', async () => {
    const bulk = Number(process.env.ANOMALY_BULK_GRANTS ?? 30);
    for (let i = 0; i < bulk; i += 1) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit.audit_logs (tenant_id, actor_id, action, detail)
         VALUES ($1::uuid, $2::uuid, 'grant.create', '{}'::jsonb)`,
        TENANT, ownerId,
      );
    }
    notifier.alerts = [];
    const signals = await anomalies.detect(24);
    const mine = signals.find((s) => s.actorId === ownerId && s.ruleId === 'AN-3');
    expect(mine).toBeDefined();
    expect(Number(mine!.detail.count)).toBeGreaterThanOrEqual(bulk);
    // 신호는 L-2 후보로만 올라간다 — 자동 동결하면 오탐 한 번의 비용이 너무 크다
    expect(notifier.alerts.some((a) => a.level === 'L2' && a.title.includes('AN-3'))).toBe(true);
    expect(await prisma.governanceFreeze.count({ where: { user_id: ownerId, status: 'ACTIVE' } })).toBe(0);

    // 사람이 확인한 뒤에야 동결로 승격된다
    await anomalies.escalateToFreeze(mine!, adminId);
    expect(await prisma.governanceFreeze.count({ where: { user_id: ownerId, status: 'ACTIVE' } })).toBe(1);
  });
});
