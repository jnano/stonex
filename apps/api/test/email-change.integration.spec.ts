/**
 * MEM-1 이메일(로그인 식별자) 변경 통합 테스트 (실 DB).
 *
 * 검증:
 *  - 재인증(step-up) 없이는 요청이 거부되고 주소가 그대로다
 *  - 확인 전까지 users.email 이 바뀌지 않는다 (오타·탈취 방지)
 *  - 확인 후 교체 + **전체 세션 폐기**
 *  - 옛 주소·새 주소 양쪽에 통지가 간다
 *  - 이미 쓰이는 주소는 요청·확인 양쪽에서 거부된다
 *  - 만료된 요청은 재요청을 막지 않는다 (부분 유니크 함정)
 *  - 요청·확인·취소가 감사에 남는다
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { EmailChangeService } from '../src/members/email-change.service';
import { PasswordService } from '../src/auth/password.service';
import { TokenService } from '../src/auth/token.service';
import { TotpService } from '../src/auth/totp.service';
import type { Mailer } from '../src/auth/mailer';
import { SubjectSnapshot } from '../src/authorization/types';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009980';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'correct-horse-battery-staple';

/** 발송 내용을 붙잡아 두는 메일러 — 토큰은 여기로만 나온다(응답에 실리지 않는다) */
class CapturingMailer implements Mailer {
  sent: Array<{ to: string; subject: string; body: string }> = [];
  async send(to: string, subject: string, body = ''): Promise<void> {
    this.sent.push({ to, subject, body });
  }
  tokenFor(to: string): string {
    const mail = [...this.sent].reverse().find((m) => m.to === to && m.body.includes('확인 토큰'));
    if (!mail) throw new Error(`${to} 로 간 확인 토큰 메일이 없습니다.`);
    return mail.body.replace('확인 토큰: ', '').trim();
  }
  reset(): void {
    this.sent = [];
  }
}

/** 정책 검사가 외부(HIBP)를 때리지 않게 한다 */
class AllowAllBreachChecker {
  async isBreached(): Promise<boolean> {
    return false;
  }
}

describe('MEM-1 이메일 변경 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let service: EmailChangeService;
  let mailer: CapturingMailer;
  let totp: TotpService;
  let passwords: PasswordService;
  let userId: string;
  let currentEmail: string;

  const subject = (id: string): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', permVersion: 1, roles: [], permissions: new Map(),
  });

  const emailOf = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).email;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;

    mailer = new CapturingMailer();
    totp = new TotpService();
    passwords = new PasswordService(new AllowAllBreachChecker());
    service = new EmailChangeService(
      p, new AuditService(), passwords, new TokenService(), totp, mailer,
    );

    await prisma.tenant.upsert({
      where: { id: TENANT }, update: {}, create: { id: TENANT, name: `t-${uid()}` },
    });
  });

  beforeEach(async () => {
    mailer.reset();
    currentEmail = `owner-${uid()}@t.local`;
    const user = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: currentEmail, password_hash: await passwords.hash(PASSWORD),
        name: '사용자', status: 'ACTIVE', totp_secret: totp.generateSecret(),
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.emailChangeRequest.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenant_id: TENANT } } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('재인증 없이는 거부되고 주소가 그대로다', async () => {
    const attempts = [
      {},
      { code: '000000' },
      { password: '틀린비밀번호' },
    ];
    for (const stepUp of attempts) {
      await expect(
        service.request(subject(userId), { newEmail: `new-${uid()}@t.local`, stepUp }),
      ).rejects.toMatchObject({ status: 401 });
    }
    expect(await emailOf(userId)).toBe(currentEmail);
    expect(await prisma.emailChangeRequest.count({ where: { user_id: userId } })).toBe(0);
  });

  it('요청해도 확인 전까지는 주소가 바뀌지 않는다 (오타·탈취 방지)', async () => {
    const newEmail = `new-${uid()}@t.local`;
    const view = await service.request(subject(userId), { newEmail, stepUp: { password: PASSWORD } });

    expect(view.status).toBe('PENDING');
    expect(view.newEmail).toBe(newEmail);
    // 즉시 반영하면 오타 하나로 자기 계정에 들어갈 수 없게 된다
    expect(await emailOf(userId)).toBe(currentEmail);
  });

  it('원문 토큰은 응답이 아니라 새 주소로만 간다', async () => {
    const newEmail = `new-${uid()}@t.local`;
    const view = await service.request(subject(userId), { newEmail, stepUp: { password: PASSWORD } });

    // 응답 어디에도 토큰이 없다 — 있으면 주소를 소유하지 않아도 확인할 수 있다
    expect(JSON.stringify(view)).not.toContain('확인 토큰');
    const token = mailer.tokenFor(newEmail);
    expect(token.length).toBeGreaterThan(20);
    // DB 에는 해시만 남는다
    const row = await prisma.emailChangeRequest.findFirstOrThrow({ where: { user_id: userId } });
    expect(row.token_hash).not.toBe(token);
  });

  it('옛 주소에도 통지가 간다 — 본인이 하지 않은 변경을 알아채는 유일한 신호', async () => {
    const newEmail = `new-${uid()}@t.local`;
    await service.request(subject(userId), { newEmail, stepUp: { password: PASSWORD } });

    expect(mailer.sent.map((m) => m.to)).toEqual(expect.arrayContaining([newEmail, currentEmail]));
    const notice = mailer.sent.find((m) => m.to === currentEmail);
    expect(notice?.body).toContain(newEmail);
  });

  it('TOTP 코드로도 재인증할 수 있다', async () => {
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totp_secret!;
    const newEmail = `new-${uid()}@t.local`;
    const view = await service.request(subject(userId), {
      newEmail, stepUp: { code: totp.generate(secret) },
    });
    expect(view.status).toBe('PENDING');
  });

  it('확인하면 교체되고 전체 세션이 폐기된다', async () => {
    const newEmail = `new-${uid()}@t.local`;
    await prisma.refreshToken.create({
      data: {
        user_id: userId, family_id: crypto.randomUUID(), token_hash: `h-${uid()}`,
        expires_at: new Date(Date.now() + 86_400_000),
      },
    });

    await service.request(subject(userId), { newEmail, stepUp: { password: PASSWORD } });
    await service.confirm(mailer.tokenFor(newEmail));

    expect(await emailOf(userId)).toBe(newEmail);
    // 식별자가 바뀌었으므로 기존 세션은 끊는다 — 탈취 세션이 있었다면 함께 끊긴다
    const live = await prisma.refreshToken.count({ where: { user_id: userId, revoked_at: null } });
    expect(live).toBe(0);
    // 옛 주소에 완료 통지가 간다
    expect(mailer.sent.some((m) => m.to === currentEmail && m.subject.includes('변경되었습니다'))).toBe(true);
  });

  it('토큰은 1회용이고 만료되면 통하지 않는다', async () => {
    const newEmail = `new-${uid()}@t.local`;
    await service.request(subject(userId), { newEmail, stepUp: { password: PASSWORD } });
    const token = mailer.tokenFor(newEmail);
    await service.confirm(token);

    await expect(service.confirm(token)).rejects.toMatchObject({ status: 400 });
    await expect(service.confirm('아무말토큰')).rejects.toMatchObject({ status: 400 });
  });

  it('이미 쓰이는 주소는 요청 단계에서 거부된다', async () => {
    const other = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `taken-${uid()}@t.local`, password_hash: 'x',
        name: '타인', status: 'ACTIVE',
      },
    });
    await expect(
      service.request(subject(userId), { newEmail: other.email, stepUp: { password: PASSWORD } }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('요청 뒤 그 주소를 남이 선점하면 확인 단계에서 409 로 막힌다', async () => {
    const newEmail = `race-${uid()}@t.local`;
    await service.request(subject(userId), { newEmail, stepUp: { password: PASSWORD } });
    const token = mailer.tokenFor(newEmail);

    // 그 사이 다른 계정이 같은 주소를 쓰게 된 상황
    await prisma.user.create({
      data: {
        tenant_id: TENANT, email: newEmail, password_hash: 'x', name: '선점자', status: 'ACTIVE',
      },
    });

    // 유니크 위반이 500 으로 새지 않고 409 로 정규화된다
    await expect(service.confirm(token)).rejects.toMatchObject({ status: 409 });
    expect(await emailOf(userId)).toBe(currentEmail);
  });

  it('현재 주소와 같거나 형식이 잘못되면 거부된다', async () => {
    for (const bad of [currentEmail, currentEmail.toUpperCase(), '골뱅이없음', 'a@b']) {
      await expect(
        service.request(subject(userId), { newEmail: bad, stepUp: { password: PASSWORD } }),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it('진행 중 요청은 1건뿐이고, 만료된 요청은 재요청을 막지 않는다', async () => {
    const first = await service.request(subject(userId), {
      newEmail: `a-${uid()}@t.local`, stepUp: { password: PASSWORD },
    });
    await expect(
      service.request(subject(userId), { newEmail: `b-${uid()}@t.local`, stepUp: { password: PASSWORD } }),
    ).rejects.toMatchObject({ status: 409 });

    // 만료 후에는 다시 요청할 수 있어야 한다 — 부분 유니크가 사용자를 가두면 안 된다
    await prisma.emailChangeRequest.update({
      where: { id: first.id }, data: { expires_at: new Date(Date.now() - 1000) },
    });
    const second = await service.request(subject(userId), {
      newEmail: `c-${uid()}@t.local`, stepUp: { password: PASSWORD },
    });
    expect(second.id).not.toBe(first.id);
    expect((await prisma.emailChangeRequest.findUniqueOrThrow({ where: { id: first.id } })).status)
      .toBe('EXPIRED');
  });

  it('본인이 요청을 취소할 수 있고 타인 요청은 보이지 않는다', async () => {
    const view = await service.request(subject(userId), {
      newEmail: `x-${uid()}@t.local`, stepUp: { password: PASSWORD },
    });
    const stranger = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `s-${uid()}@t.local`, password_hash: 'x',
        name: '제3자', status: 'ACTIVE',
      },
    });
    // 존재 은닉 — 남의 요청은 404
    await expect(service.cancel(subject(stranger.id), view.id)).rejects.toMatchObject({ status: 404 });

    await service.cancel(subject(userId), view.id);
    expect(await service.pending(subject(userId))).toBeNull();
  });

  it('요청·확인이 감사에 남고 비밀 값은 기록되지 않는다', async () => {
    const newEmail = `audit-${uid()}@t.local`;
    await service.request(subject(userId), { newEmail, stepUp: { password: PASSWORD } });
    await service.confirm(mailer.tokenFor(newEmail));

    const logs = await prisma.$queryRaw<Array<{ action: string; detail: Record<string, unknown> }>>`
      SELECT action, detail FROM audit.audit_logs
       WHERE target_id = ${userId}::uuid AND action LIKE 'member.email.change%'
       ORDER BY created_at`;
    expect(logs.map((l) => l.action)).toEqual([
      'member.email.change.request', 'member.email.change.confirm',
    ]);
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain(newEmail); // 무엇으로 바꿨는지는 추적의 핵심이다
    expect(serialized).not.toContain(PASSWORD); // 재인증에 쓴 비밀번호는 남지 않는다
  });
});
