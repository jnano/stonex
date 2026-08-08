/**
 * WP-2 통합 테스트 (실 DB) — AUTH-1~4, 온보딩 게이트, JWT/pv 대조.
 * DoD:
 *  - AUTH-1~4 정상 + 이상 흐름(잠금·재사용 탐지·정지 계정 갱신 거부)
 *  - 폐기 토큰 재사용 시 family 전체 무효화
 *  - JWT 페이로드에 역할·권한 없음 (회귀 방지)
 *  - 가입(이메일 인증) 시 역할 부여가 감사 로그에 기록 + 기록 실패 시 롤백
 *  - 최초 SUPER_ADMIN 온보딩 미완료 시 일반·관리 API 차단
 *  - requires_2fa 보유 + TOTP 미등록 → refresh 갱신 거부 (RT-7-b)
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { decodeJwt } from 'jose';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { AuthService } from '../src/auth/auth.service';
import { GovernanceFreezeService } from '../src/governance/freeze.service';
import { AuditService } from '../src/audit/audit.service';
import { RoleGrantService } from '../src/authorization/role-grant.service';
import { PermVersionService } from '../src/cache/perm-version.service';
import { PermissionCacheService } from '../src/cache/permission-cache.service';
import { RedisService } from '../src/cache/redis.service';
import { PasswordService, AllowAllBreachChecker } from '../src/auth/password.service';
import { TokenService } from '../src/auth/token.service';
import { TotpService } from '../src/auth/totp.service';
import { Mailer } from '../src/auth/mailer';
import { PrismaService } from '../src/prisma/prisma.service';
import { isPathAllowedDuringOnboarding, isOnboardingComplete } from '../src/auth/onboarding';

jest.setTimeout(90_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 테스트는 실제 DB를 요구).');
process.env.JWT_SECRET ??= 'test-secret-value-at-least-32-characters-long';

const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000000';

/** 발송된 토큰을 가로채는 테스트 메일러 */
class CapturingMailer implements Mailer {
  last: { to: string; body: string } | null = null;
  async send(to: string, _subject: string, body: string): Promise<void> {
    this.last = { to, body };
  }
  token(): string {
    const m = this.last?.body.match(/토큰: (\S+)/);
    if (!m) throw new Error('메일에서 토큰을 찾지 못했습니다');
    return m[1];
  }
}

describe('WP-2 인증 (실 DB)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let mailer: CapturingMailer;
  let tokens: TokenService;
  const emails: string[] = [];

  const uniqueEmail = (tag: string) => {
    const e = `${tag}-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}@t.local`;
    emails.push(e);
    return e;
  };

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });

    // 기본 테넌트·MEMBER/OPERATOR 역할 시드 (verifyEmail·2FA 테스트가 요구)
    await prisma.tenant.upsert({ where: { id: DEFAULT_TENANT }, update: {}, create: { id: DEFAULT_TENANT, name: 'default' } });
    await prisma.role.upsert({
      where: { tenant_id_code: { tenant_id: DEFAULT_TENANT, code: 'MEMBER' } },
      update: {}, create: { tenant_id: DEFAULT_TENANT, code: 'MEMBER', name: '일반회원', is_system: true },
    });
    await prisma.role.upsert({
      where: { tenant_id_code: { tenant_id: DEFAULT_TENANT, code: 'OPERATOR' } },
      update: { requires_2fa: true },
      create: { tenant_id: DEFAULT_TENANT, code: 'OPERATOR', name: '운영자', requires_2fa: true },
    });

    const p = prisma as unknown as PrismaService;
    mailer = new CapturingMailer();
    tokens = new TokenService();
    auth = new AuthService(
      p,
      new RoleGrantService(
        new AuditService(),
        new PermVersionService(p, new PermissionCacheService(new RedisService())),
        new GovernanceFreezeService(p, new AuditService()),
      ),
      new PasswordService(new AllowAllBreachChecker()),
      tokens, new TotpService(), mailer, new RedisService(),
    );
  });

  afterAll(async () => {
    for (const email of emails) {
      const u = await prisma.user.findUnique({ where: { tenant_id_email: { tenant_id: DEFAULT_TENANT, email } } });
      if (!u) continue;
      await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE target_id = ${u.id}::uuid`;
      await prisma.userRole.deleteMany({ where: { user_id: u.id } });
      await prisma.user.delete({ where: { id: u.id } });
    }
    await prisma.$disconnect();
  });

  it('AUTH-1: 가입은 PENDING, 이메일 인증 시 ACTIVE + MEMBER 부여 + 감사 기록 (INV-6)', async () => {
    const email = uniqueEmail('signup');
    const { userId } = await auth.signup(email, 'correct-horse-battery', '가입자');
    const pending = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(pending.status).toBe('PENDING');

    await auth.verifyEmail(mailer.token());

    const active = await prisma.user.findUniqueOrThrow({
      where: { id: userId }, include: { user_roles: { include: { role: true } } },
    });
    expect(active.status).toBe('ACTIVE');
    expect(active.user_roles.map((r) => r.role.code)).toEqual(['MEMBER']);

    const logs = await prisma.$queryRaw<Array<{ action: string; actor_id: string | null }>>`
      SELECT action, actor_id FROM audit.audit_logs WHERE target_id = ${userId}::uuid AND action = 'role.grant'`;
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBeNull(); // 시스템 행위
  });

  it('AUTH-2: 실패 5회 시 잠금, 올바른 비밀번호도 거부', async () => {
    const email = uniqueEmail('lock');
    const { userId } = await auth.signup(email, 'correct-horse-battery', '잠금');
    await auth.verifyEmail(mailer.token());

    for (let i = 0; i < 5; i++) {
      await expect(auth.login(email, 'wrong-password-x')).rejects.toThrow();
    }
    const locked = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(locked.failed_login_count).toBe(5);
    expect(locked.locked_until).not.toBeNull();
    await expect(auth.login(email, 'correct-horse-battery')).rejects.toThrow();
  });

  it('AUTH-2: JWT 페이로드에 역할·권한이 없다 (§8.1 회귀 방지)', async () => {
    const email = uniqueEmail('jwt');
    await auth.signup(email, 'correct-horse-battery', 'JWT');
    await auth.verifyEmail(mailer.token());
    const pair = await auth.login(email, 'correct-horse-battery');

    const payload = decodeJwt(pair.accessToken);
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'pv', 'sub', 'tenant']);
    expect(JSON.stringify(payload)).not.toMatch(/MEMBER|permission|role/i);
  });

  it('AUTH-3: 회전 후 이전 토큰 재사용 → family 전체 폐기', async () => {
    const email = uniqueEmail('rotate');
    await auth.signup(email, 'correct-horse-battery', '회전');
    await auth.verifyEmail(mailer.token());
    const first = await auth.login(email, 'correct-horse-battery');

    const second = await auth.refresh(first.refreshToken); // 정상 회전
    expect(second.refreshToken).not.toBe(first.refreshToken);

    await expect(auth.refresh(first.refreshToken)).rejects.toThrow(); // 재사용 탐지
    await expect(auth.refresh(second.refreshToken)).rejects.toThrow(); // family 전체 폐기됨
  });

  it('AUTH-3: 정지 계정은 갱신 거부 + family 폐기', async () => {
    const email = uniqueEmail('susp');
    const { userId } = await auth.signup(email, 'correct-horse-battery', '정지');
    await auth.verifyEmail(mailer.token());
    const pair = await auth.login(email, 'correct-horse-battery');

    await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });
    await expect(auth.refresh(pair.refreshToken)).rejects.toThrow();

    const alive = await prisma.refreshToken.count({ where: { user_id: userId, revoked_at: null } });
    expect(alive).toBe(0);
  });

  it('AUTH-3: requires_2fa 역할 보유 + TOTP 미등록 → 갱신 거부 (RT-7-b)', async () => {
    const email = uniqueEmail('twofa');
    const { userId } = await auth.signup(email, 'correct-horse-battery', '2FA');
    await auth.verifyEmail(mailer.token());
    const pair = await auth.login(email, 'correct-horse-battery');

    const operator = await prisma.role.findUniqueOrThrow({
      where: { tenant_id_code: { tenant_id: DEFAULT_TENANT, code: 'OPERATOR' } },
    });
    await prisma.userRole.create({ data: { tenant_id: DEFAULT_TENANT, user_id: userId, role_id: operator.id } });
    await prisma.user.update({ where: { id: userId }, data: { totp_enrollment_required: true } });

    await expect(auth.refresh(pair.refreshToken)).rejects.toThrow();
  });

  it('AUTH-4: 재설정 완료 시 전체 세션 폐기 + 새 비밀번호로 로그인', async () => {
    const email = uniqueEmail('reset');
    const { userId } = await auth.signup(email, 'correct-horse-battery', '재설정');
    await auth.verifyEmail(mailer.token());
    const pair = await auth.login(email, 'correct-horse-battery');

    await auth.requestPasswordReset(email);
    await auth.resetPassword(mailer.token(), 'brand-new-password-1');

    await expect(auth.refresh(pair.refreshToken)).rejects.toThrow(); // 기존 세션 무효
    const relogin = await auth.login(email, 'brand-new-password-1');
    expect(relogin.accessToken).toBeTruthy();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).must_change_password).toBe(false);
  });

  it('온보딩(§8.5): 완료 전에는 온보딩 경로만 허용, 완료 후 해제', async () => {
    const email = uniqueEmail('onboard');
    const { userId } = await auth.signup(email, 'correct-horse-battery', '온보딩');
    await auth.verifyEmail(mailer.token());
    // 시드 SUPER_ADMIN 과 동일한 초기 상태 재현
    await prisma.user.update({
      where: { id: userId }, data: { must_change_password: true, totp_enrollment_required: true },
    });

    let status = await auth.onboardingStatus(userId);
    expect(isOnboardingComplete({ mustChangePassword: status.mustChangePassword, totpEnrollmentRequired: status.totpEnrollmentRequired })).toBe(false);
    expect(isPathAllowedDuringOnboarding('/api/v1/members')).toBe(false); // 일반·관리 API 차단
    expect(isPathAllowedDuringOnboarding('/api/v1/auth/onboarding/password')).toBe(true);

    await auth.completePasswordOnboarding(userId, 'another-strong-pass-9');
    const { keyUri } = await auth.beginTotpEnrollment(userId);
    expect(keyUri).toContain('otpauth://');
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totp_secret;
    await auth.confirmTotpEnrollment(userId, new TotpService().generate(secret as string));

    status = await auth.onboardingStatus(userId);
    expect(isOnboardingComplete({ mustChangePassword: status.mustChangePassword, totpEnrollmentRequired: status.totpEnrollmentRequired })).toBe(true);
  });

  describe('CR-1: TOTP 재등록 step-up (Phase 1 코드 리뷰 필수 수정)', () => {
    /** 온보딩을 마치고 2FA 가 등록된 계정을 만든다 */
    const enrolledUser = async (label: string) => {
      const email = uniqueEmail(label);
      const password = 'correct-horse-battery';
      const { userId } = await auth.signup(email, password, label);
      await auth.verifyEmail(mailer.token());
      await prisma.user.update({ where: { id: userId }, data: { totp_enrollment_required: true } });
      await auth.beginTotpEnrollment(userId);
      const secret = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totp_secret!;
      await auth.confirmTotpEnrollment(userId, new TotpService().generate(secret));
      return { userId, password, secret };
    };

    it('(a) 온보딩 중 최초 등록은 성공한다', async () => {
      const email = uniqueEmail('first-enroll');
      const { userId } = await auth.signup(email, 'correct-horse-battery', '최초등록');
      await auth.verifyEmail(mailer.token());
      await prisma.user.update({ where: { id: userId }, data: { totp_enrollment_required: true } });

      const { keyUri } = await auth.beginTotpEnrollment(userId);
      expect(keyUri).toContain('otpauth://');
    });

    it('(b) 등록을 마친 계정의 온보딩 경로 재등록은 거부된다 — 세션 탈취자의 2FA 교체 차단', async () => {
      const { userId, secret } = await enrolledUser('reenroll-denied');

      // 이 경로가 열려 있으면 토큰을 탈취한 공격자가 피해자의 인증기를 자기 것으로 바꾼다
      await expect(auth.beginTotpEnrollment(userId)).rejects.toMatchObject({ status: 403 });
      // 기존 시크릿이 그대로여야 한다
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totp_secret).toBe(secret);
    });

    it('(b-2) step-up 없이 재등록을 시도하면 401 이고 시크릿이 바뀌지 않는다', async () => {
      const { userId, secret } = await enrolledUser('reenroll-nostep');

      await expect(auth.beginTotpReenrollment(userId, {})).rejects.toMatchObject({ status: 401 });
      await expect(auth.beginTotpReenrollment(userId, { code: '000000' })).rejects.toMatchObject({ status: 401 });
      await expect(auth.beginTotpReenrollment(userId, { password: '틀린비밀번호' })).rejects.toMatchObject({ status: 401 });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totp_secret).toBe(secret);
    });

    it('(c) step-up(현재 TOTP 코드) 후 재등록에 성공한다', async () => {
      const { userId, secret } = await enrolledUser('reenroll-code');
      const totp = new TotpService();

      const { keyUri } = await auth.beginTotpReenrollment(userId, { code: totp.generate(secret) });
      expect(keyUri).toContain('otpauth://');

      // **확인 전에는 기존 시크릿이 살아 있어야 한다** — 즉시 덮어쓰면 확인을 끝내지 않는 것만으로
      // 피해자의 인증기가 무효가 되어 계정을 잠글 수 있다
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totp_secret).toBe(secret);

      const newSecret = new URL(keyUri).searchParams.get('secret')!;
      await auth.confirmTotpReenrollment(userId, totp.generate(newSecret));
      const after = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totp_secret;
      expect(after).toBe(newSecret);
      expect(after).not.toBe(secret);
    });

    it('(c-2) step-up(비밀번호) 후 재등록에 성공한다', async () => {
      const { userId, password } = await enrolledUser('reenroll-pw');
      const totp = new TotpService();

      const { keyUri } = await auth.beginTotpReenrollment(userId, { password });
      const newSecret = new URL(keyUri).searchParams.get('secret')!;
      await auth.confirmTotpReenrollment(userId, totp.generate(newSecret));
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totp_secret).toBe(newSecret);
    });

    it('재등록 확인은 미확정 요청이 없으면 거부된다 (확인 단독 호출 방지)', async () => {
      const { userId } = await enrolledUser('reenroll-orphan');
      await expect(auth.confirmTotpReenrollment(userId, '000000')).rejects.toMatchObject({ status: 400 });
    });
  });

  it('JWT: pv 불일치 토큰은 거부된다 (§8.3 권한 회수 즉시 전파)', async () => {
    const email = uniqueEmail('pv');
    const { userId } = await auth.signup(email, 'correct-horse-battery', 'PV');
    await auth.verifyEmail(mailer.token());
    const pair = await auth.login(email, 'correct-horse-battery');

    const { JwtTokenVerifier } = await import('../src/auth/jwt-token-verifier');
    // 검증기는 서명·클레임까지 담당하고, pv 대조는 AuthGuard 가 스냅샷·DB 와 수행한다(§8.3)
    const verifier = new JwtTokenVerifier(tokens);
    const claims = await verifier.verify(`Bearer ${pair.accessToken}`);
    expect(claims?.userId).toBe(userId);

    await prisma.user.update({ where: { id: userId }, data: { perm_version: { increment: 1 } } });
    const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(current.perm_version).not.toBe(claims?.pv); // AuthGuard 가 이 불일치로 토큰을 거부한다
  });
});
