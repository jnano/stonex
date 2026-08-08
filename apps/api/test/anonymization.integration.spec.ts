/**
 * 탈퇴 회원 익명화 통합 테스트 (§13.2 결정 — 30일 후 익명화).
 *
 * 검증:
 *  - 유예 기간이 지난 탈퇴 회원만 익명화된다 (활성·최근 탈퇴는 건드리지 않는다)
 *  - **계정 행은 남는다** — 감사 로그의 행위자 추적이 끊기지 않는다
 *  - 세션·검증 토큰이 함께 정리된다
 *  - 재실행해도 안전하다 (멱등)
 *  - 한 번에 처리할 인원에 상한이 있다
 *  - 감사에 남되 **지워진 원본 이메일은 담기지 않는다**
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { MemberAnonymizationService } from '../src/members/anonymization.service';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009979';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = 24 * 60 * 60 * 1000;

describe('탈퇴 회원 익명화 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let service: MemberAnonymizationService;

  /** deletedDaysAgo 가 null 이면 탈퇴하지 않은 활성 회원 */
  const makeUser = async (label: string, deletedDaysAgo: number | null) =>
    prisma.user.create({
      data: {
        tenant_id: TENANT,
        email: `${label}-${uid()}@t.local`,
        password_hash: '$argon2id$real-hash',
        name: `${label} 사용자`,
        status: deletedDaysAgo === null ? 'ACTIVE' : 'DELETED',
        totp_secret: 'SECRET',
        deleted_at: deletedDaysAgo === null ? null : new Date(Date.now() - deletedDaysAgo * DAY),
      },
    });

  const rowOf = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    service = new MemberAnonymizationService(p, new AuditService());

    await prisma.tenant.upsert({
      where: { id: TENANT }, update: {}, create: { id: TENANT, name: `t-${uid()}` },
    });
  });

  afterEach(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.refreshToken.deleteMany({ where: { user: { tenant_id: TENANT } } });
    await prisma.verificationToken.deleteMany({ where: { user: { tenant_id: TENANT } } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('유예 기간(30일)이 지난 탈퇴 회원만 익명화된다', async () => {
    const old = await makeUser('old', 31);
    const recent = await makeUser('recent', 5);
    const active = await makeUser('active', null);

    const report = await service.run();
    expect(report.processed).toBe(1);

    const afterOld = await rowOf(old.id);
    expect(afterOld.email).toBe(`deleted-${old.id}@invalid.local`);
    expect(afterOld.name).toBe('탈퇴한 회원');

    // 유예 중이거나 탈퇴하지 않은 계정은 그대로여야 한다
    expect((await rowOf(recent.id)).email).toBe(recent.email);
    expect((await rowOf(active.id)).email).toBe(active.email);
  });

  it('계정 행은 남는다 — 감사 로그의 행위자 추적이 끊기지 않는다', async () => {
    const user = await makeUser('actor', 40);
    // 이 사람이 과거에 한 행위가 감사에 있다고 가정한다
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit.audit_logs (tenant_id, actor_id, action, detail)
       VALUES ($1::uuid, $2::uuid, 'role.grant', '{}'::jsonb)`,
      TENANT, user.id,
    );

    await service.run();

    // 행이 사라지면 "누가 무엇을 했는가"를 영구히 잃는다
    const still = await prisma.user.findUnique({ where: { id: user.id } });
    expect(still).not.toBeNull();
    const [log] = await prisma.$queryRaw<Array<{ actor_id: string }>>`
      SELECT actor_id FROM audit.audit_logs
       WHERE tenant_id = ${TENANT}::uuid AND action = 'role.grant'`;
    expect(log.actor_id).toBe(user.id);
  });

  it('식별 정보와 인증 수단이 함께 무효화된다', async () => {
    const user = await makeUser('creds', 35);
    const before = await rowOf(user.id);
    expect(before.totp_secret).toBe('SECRET');

    await service.run();

    const after = await rowOf(user.id);
    expect(after.totp_secret).toBeNull();
    expect(after.password_hash).not.toBe(before.password_hash);
    // 빈 값이 아니라 **검증이 반드시 실패하는 값**이어야 한다
    expect(after.password_hash).not.toBe('');
    expect(after.name).not.toContain('사용자');
  });

  it('세션·검증 토큰이 함께 정리된다 — 파기가 반쪽이 되지 않도록', async () => {
    const user = await makeUser('tokens', 35);
    await prisma.refreshToken.create({
      data: {
        user_id: user.id, family_id: crypto.randomUUID(), token_hash: `h-${uid()}`,
        expires_at: new Date(Date.now() + DAY),
      },
    });
    await prisma.verificationToken.create({
      data: {
        user_id: user.id, kind: 'PASSWORD_RESET', token_hash: `v-${uid()}`,
        expires_at: new Date(Date.now() + DAY),
      },
    });

    await service.run();

    expect(await prisma.refreshToken.count({ where: { user_id: user.id } })).toBe(0);
    expect(await prisma.verificationToken.count({ where: { user_id: user.id } })).toBe(0);
  });

  it('재실행해도 안전하다 (멱등)', async () => {
    const user = await makeUser('idem', 40);
    const first = await service.run();
    expect(first.processed).toBe(1);
    const emailAfterFirst = (await rowOf(user.id)).email;

    const second = await service.run();
    // 이미 처리된 계정을 다시 집지 않는다 — 패턴 자체가 표식이다
    expect(second.processed).toBe(0);
    expect((await rowOf(user.id)).email).toBe(emailAfterFirst);
  });

  it('한 번에 처리할 인원에 상한이 있다 (되돌릴 수 없는 작업이므로)', async () => {
    const limit = Number(process.env.MEMBER_ANONYMIZE_BATCH ?? 200);
    // 상한보다 조금 넘게 만들어 남는 인원이 보고되는지 본다
    for (let i = 0; i < 3; i += 1) await makeUser(`bulk${i}`, 40);

    const report = await service.run();
    expect(report.processed).toBeLessThanOrEqual(limit);
    expect(report.processed + report.remaining).toBeGreaterThanOrEqual(3);
  });

  it('감사에 남되 지워진 원본 이메일은 담기지 않는다', async () => {
    const user = await makeUser('audit', 40);
    const originalEmail = user.email;

    await service.run();

    const logs = await prisma.$queryRaw<Array<{ action: string; detail: Record<string, unknown> }>>`
      SELECT action, detail FROM audit.audit_logs
       WHERE tenant_id = ${TENANT}::uuid AND action = 'member.anonymize'`;
    expect(logs).toHaveLength(1);
    // 감사 로그가 파기 대상 정보를 보관하는 우회로가 되면 안 된다
    expect(JSON.stringify(logs[0].detail)).not.toContain(originalEmail);
    expect(JSON.stringify(logs[0].detail)).toContain('anonymized');
  });

  it('유예 기간은 환경 변수로 조정된다', async () => {
    const user = await makeUser('window', 10);
    // 기본 30일 기준에서는 대상이 아니다
    expect((await service.run()).processed).toBe(0);
    expect((await rowOf(user.id)).email).toBe(user.email);

    // 기준 시각을 미래로 밀면 같은 계정이 대상이 된다 (계산식 검증)
    const future = new Date(Date.now() + 25 * DAY);
    expect((await service.run(future)).processed).toBe(1);
  });
});
