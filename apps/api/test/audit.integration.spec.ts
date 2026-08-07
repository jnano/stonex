/**
 * WP-6a 통합 테스트 — 실제 PostgreSQL 대상 (TEST_DATABASE_URL 필수, 없으면 실패).
 * DoD: (1) 감사 기록 실패 주입 시 권한 변경 트랜잭션 롤백(INV-6)
 *      (2) 역할 부여 1건의 변경 전/후 값이 감사 로그에서 재구성 가능
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { recordAudit } from '../src/audit/audit-record';

jest.setTimeout(60_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });

const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) {
  // 조용한 skip 금지 — DB 없는 환경에서는 명시적으로 실패시켜 커버리지 공백을 드러낸다
  throw new Error('TEST_DATABASE_URL 이 필요합니다 (.env 또는 CI env — 통합 테스트는 실제 DB를 요구).');
}

const TENANT = '00000000-0000-0000-0000-000000009999'; // 테스트 전용 테넌트 (기본 테넌트와 분리)

describe('감사 기록 (INV-6)', () => {
  let prisma: PrismaClient;
  let userId: string;
  let roleId: string;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: TEST_URL },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });

    await prisma.tenant.upsert({
      where: { id: TENANT },
      update: {},
      create: { id: TENANT, name: 'audit-test', status: 'ACTIVE' },
    });
    const user = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `audit-${Date.now()}@test.local`,
        password_hash: 'x', name: '피부여자', status: 'ACTIVE',
      },
    });
    const role = await prisma.role.create({
      data: { tenant_id: TENANT, code: `AUDIT_T_${Date.now()}`, name: '감사테스트역할' },
    });
    userId = user.id;
    roleId = role.id;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
  });

  it('감사 기록이 실패하면 역할 부여 트랜잭션 전체가 롤백된다 (INV-6)', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.userRole.create({
          data: { tenant_id: TENANT, user_id: userId, role_id: roleId },
        });
        // 기록 실패 주입: tenant_id에 UUID가 아닌 값 → INSERT가 DB 수준에서 실패
        await recordAudit(tx, {
          tenantId: 'uuid-아님',
          actorId: null,
          action: 'role.grant',
        });
      }),
    ).rejects.toThrow();

    const granted = await prisma.userRole.count({ where: { user_id: userId, role_id: roleId } });
    expect(granted).toBe(0); // 변경이 함께 롤백되어야 한다
  });

  it('역할 부여의 변경 전/후 값이 감사 로그에서 재구성 가능하다', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.userRole.create({
        data: { tenant_id: TENANT, user_id: userId, role_id: roleId },
      });
      await recordAudit(tx, {
        tenantId: TENANT,
        actorId: null, // 시스템 행위
        action: 'role.grant',
        targetType: 'user',
        targetId: userId,
        detail: { before: { roles: [] }, after: { roles: ['AUDIT_T'] } },
        ipAddress: '127.0.0.1',
      });
    });

    const rows = await prisma.$queryRaw<
      Array<{ action: string; actor_id: string | null; target_id: string; detail: { before: { roles: string[] }; after: { roles: string[] } } }>
    >`SELECT action, actor_id, target_id, detail FROM audit_logs
      WHERE tenant_id = ${TENANT}::uuid AND action = 'role.grant' ORDER BY created_at DESC LIMIT 1`;

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('role.grant');
    expect(rows[0].actor_id).toBeNull(); // 시스템 행위 = NULL (WP-6a 항목 2)
    expect(rows[0].target_id).toBe(userId);
    expect(rows[0].detail.before.roles).toEqual([]); // 변경 전
    expect(rows[0].detail.after.roles).toEqual(['AUDIT_T']); // 변경 후 — 재구성 가능
  });
});
