/**
 * 시스템 설정 통합 테스트 (범용 배포 지원).
 *
 * 검증:
 *  - **비밀값은 어떤 응답에도 실리지 않는다** — "설정됨" 여부만 나간다
 *  - DB 에는 암호문으로 저장되고 평문이 남지 않는다
 *  - 비밀 항목을 빈 칸으로 저장하면 "변경 없음"이다 (다른 항목 고치다 비밀번호가 지워지지 않도록)
 *  - 저장하면 세대가 올라 소비자가 접속 객체를 다시 만든다 (재기동 없이 반영)
 *  - 감사에 남되 값은 남지 않는다
 *  - 정의에 없는 항목·잘못된 형식은 거부된다
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { SettingsService } from '../src/settings/settings.service';
import { open, seal } from '../src/settings/secret-box';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009978';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SECRET = 'app-password-1234';

describe('시스템 설정 (실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let settings: SettingsService;
  let actorId: string;

  const actor = () => ({ id: actorId, tenantId: TENANT });

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL;
    // 암호화 키가 없으면 비밀값 저장 자체가 불가능하다 — 테스트 전용 키를 넣는다
    process.env.SETTINGS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    settings = new SettingsService(p, new AuditService());

    await prisma.tenant.upsert({
      where: { id: TENANT }, update: {}, create: { id: TENANT, name: `t-${uid()}` },
    });
    actorId = (await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `admin-${uid()}@t.local`, password_hash: 'x',
        name: '관리자', status: 'ACTIVE',
      },
    })).id;
  });

  afterEach(async () => {
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.systemSetting.deleteMany({ where: { tenant_id: TENANT } });
    settings.invalidate();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('비밀값은 응답에 실리지 않고 "설정됨" 여부만 나간다', async () => {
    await settings.update('mail', { host: 'smtp.example.com', password: SECRET }, actor());

    const view = await settings.view(TENANT);
    const mail = view.find((c) => c.category === 'mail')!;
    const password = mail.fields.find((f) => f.key === 'password')!;
    const host = mail.fields.find((f) => f.key === 'host')!;

    expect(password.value).toBeNull(); // 값은 어떤 경로로도 나가지 않는다
    expect(password.configured).toBe(true);
    expect(host.value).toBe('smtp.example.com'); // 평문 항목은 그대로 보인다
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('DB 에는 암호문으로 저장되고 평문이 남지 않는다', async () => {
    await settings.update('mail', { password: SECRET }, actor());

    const row = await prisma.systemSetting.findFirstOrThrow({
      where: { tenant_id: TENANT, category: 'mail', key: 'password' },
    });
    expect(row.value).toBeNull();
    expect(row.secret_value).not.toBeNull();
    expect(row.secret_value).not.toContain(SECRET);
    // 서버는 복호화해 실제 값을 얻는다
    expect(open(row.secret_value!)).toBe(SECRET);
  });

  it('비밀 항목을 빈 칸으로 저장하면 변경 없음으로 처리된다', async () => {
    await settings.update('mail', { password: SECRET }, actor());
    // 호스트만 고치는 상황 — 비밀번호 칸은 비어 있다
    await settings.update('mail', { host: 'smtp.changed.com', password: '' }, actor());

    const values = await settings.values('mail', TENANT);
    expect(values.host).toBe('smtp.changed.com');
    // 빈 칸을 저장으로 처리하면 다른 항목 하나 고칠 때마다 비밀번호가 지워진다
    expect(values.password).toBe(SECRET);
  });

  it('저장하면 세대가 올라 소비자가 접속 객체를 다시 만든다', async () => {
    const before = settings.generation;
    await settings.update('mail', { host: 'smtp.a.com' }, actor());
    expect(settings.generation).toBeGreaterThan(before);

    // 캐시도 함께 비워져 새 값이 바로 보인다 (재기동 없이 반영)
    expect((await settings.values('mail', TENANT)).host).toBe('smtp.a.com');
  });

  it('감사에 남되 값은 남지 않는다', async () => {
    await settings.update('mail', { host: 'smtp.secret-host.com', password: SECRET }, actor());

    const [log] = await prisma.$queryRaw<Array<{ detail: Record<string, unknown> }>>`
      SELECT detail FROM audit.audit_logs
       WHERE tenant_id = ${TENANT}::uuid AND action = 'system.settings.update'`;
    const serialized = JSON.stringify(log.detail);

    expect(serialized).toContain('changedKeys');
    expect(serialized).toContain('password'); // 어떤 항목이 바뀌었는지는 남는다
    expect(serialized).not.toContain(SECRET); // 값은 남지 않는다
    // 평문 항목이라도 호스트는 접속 정보의 일부다
    expect(serialized).not.toContain('smtp.secret-host.com');
  });

  it('정의에 없는 항목과 잘못된 형식은 거부된다', async () => {
    await expect(settings.update('mail', { 알수없는키: 'x' }, actor()))
      .rejects.toMatchObject({ status: 400 });
    await expect(settings.update('mail', { port: '사오육' }, actor()))
      .rejects.toMatchObject({ status: 400 });
    await expect(settings.update('mail', { transport: 'telepathy' }, actor()))
      .rejects.toMatchObject({ status: 400 });
    await expect(settings.update('없는분류', { a: 'b' }, actor()))
      .rejects.toMatchObject({ status: 404 });
  });

  it('필수 항목을 비우면 거부된다', async () => {
    await expect(settings.update('storage', { bucket: '' }, actor()))
      .rejects.toMatchObject({ status: 400 });
  });

  it('암호문이 변조되면 복호화가 실패한다 (GCM 무결성)', () => {
    const sealed = seal('원본값');
    const [iv, tag, data] = sealed.split('.');
    // 마지막 바이트를 바꿔 본다 — 설정값은 접속 대상을 정하므로 무결성이 기밀성만큼 중요하다
    const broken = Buffer.from(data, 'base64');
    broken[broken.length - 1] ^= 0xff;
    expect(() => open([iv, tag, broken.toString('base64')].join('.'))).toThrow(/복호화할 수 없습니다/);
  });
});
