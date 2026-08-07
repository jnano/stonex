/**
 * WP-6b 통합 테스트 (실 DB).
 * DoD:
 *  - 애플리케이션 DB 계정(stonex_app)으로 audit_logs UPDATE/DELETE 가 DB 수준에서 거부된다(§10.3)
 *  - 삽입·조회는 정상 동작한다 (append-only)
 *  - 월 파티션 자동 생성이 멱등하게 동작한다
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { AuditPartitionService } from '../src/audit/partition.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 테스트는 실제 DB를 요구).');

const TENANT = '00000000-0000-0000-0000-000000009997';

describe('WP-6b 감사 로그 운영 (실 DB)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    await prisma.$executeRaw`
      INSERT INTO audit.audit_logs (tenant_id, actor_id, action, detail)
      VALUES (${TENANT}::uuid, NULL, 'test.seed', '{}'::jsonb)`;
  });

  afterAll(async () => {
    // 정리는 관리자 계정으로만 가능하다 — 이것이 append-only 의 증거이기도 하다
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.$disconnect();
  });

  it('stonex_app 역할은 audit_logs 를 UPDATE/DELETE 할 수 없다 (§10.3)', async () => {
    // 세션 역할을 애플리케이션 계정으로 전환해 실제 운영 권한을 재현한다
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE stonex_app');
        await tx.$executeRawUnsafe(`UPDATE audit.audit_logs SET action = 'tampered' WHERE tenant_id = '${TENANT}'`);
      }),
    ).rejects.toThrow(/permission denied|권한/i);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE stonex_app');
        await tx.$executeRawUnsafe(`DELETE FROM audit.audit_logs WHERE tenant_id = '${TENANT}'`);
      }),
    ).rejects.toThrow(/permission denied|권한/i);

    // 원본이 그대로인지 확인
    const rows = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    expect(rows.every((r) => r.action === 'test.seed')).toBe(true);
  });

  it('stonex_app 역할도 INSERT·SELECT 는 가능하다 (append-only)', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE stonex_app');
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_logs (tenant_id, actor_id, action, detail) VALUES ('${TENANT}', NULL, 'test.append', '{}'::jsonb)`,
      );
      const rows = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM audit.audit_logs WHERE tenant_id = '${TENANT}'`,
      );
      expect(Number(rows[0].count)).toBeGreaterThanOrEqual(2);
    });
  });

  it('월 파티션 생성은 멱등하다 (반복 호출 안전)', async () => {
    const service = new AuditPartitionService(prisma as unknown as PrismaService);
    await service.ensurePartitions();
    await service.ensurePartitions(); // 두 번째 호출도 실패하지 않아야 한다

    const parts = await prisma.$queryRaw<Array<{ relname: string }>>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'audit' AND c.relkind = 'r' AND c.relname LIKE 'audit_logs_%'`;
    expect(parts.length).toBeGreaterThanOrEqual(2); // 당월 + 익월
  });
});
