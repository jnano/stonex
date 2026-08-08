/**
 * 역할 우위 격자 검증 (기획서 §4.5·§14.3 RI-9, RT-21) — 실 DB.
 *
 * G-4는 시드 **정의**를 검사하고, 이 테스트는 시드가 DB에 적용된 뒤의 **실제 매핑**으로
 * `checkDominance`를 돌려 격자가 런타임에도 성립함을 확인한다.
 * 격자가 깨지면 우위 검사가 INCOMPARABLE 을 반환해 상위 역할이 하위 회원을 관리할 수 없게 된다.
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { checkDominance } from '../src/authorization/dominance';
import { DEFAULT_TENANT_ID, ROLE_LATTICE } from '../../../db/seeds/permissions';

jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 테스트는 실제 DB를 요구).');

describe('역할 우위 격자 (RI-9)', () => {
  let prisma: PrismaClient;
  const permsByRole = new Map<string, Set<string>>();

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    execSync('pnpm db:seed', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });

    const roles = await prisma.role.findMany({
      where: { tenant_id: DEFAULT_TENANT_ID },
      include: { role_permissions: { include: { permission: true } } },
    });
    for (const r of roles) {
      permsByRole.set(r.code, new Set(r.role_permissions.map((rp) => rp.permission.code)));
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(ROLE_LATTICE)('$superior 가 $inferior 를 관리할 수 있다 (DOMINANT)', ({ superior, inferior }) => {
    const sup = permsByRole.get(superior);
    const inf = permsByRole.get(inferior);
    expect(sup).toBeDefined();
    expect(inf).toBeDefined();

    const result = checkDominance('superior-user', sup!, 'inferior-user', inf!);
    expect(result).toEqual({ allowed: true, reason: 'DOMINANT', missing: [] });
  });

  it('OPERATOR 가 MEMBER 를 관리할 수 있다 — MEMBER 도메인 권한 확장(v1.7) 이후에도 성립', () => {
    const operator = permsByRole.get('OPERATOR')!;
    const member = permsByRole.get('MEMBER')!;

    // v1.7에서 MEMBER 에 도메인 owned 권한 5종이 추가됐다. OPERATOR 가 이를 따라가지 못하면
    // INCOMPARABLE 이 되어 운영자가 일반 회원을 정지·수정·삭제할 수 없다(전 회원 관리 마비).
    for (const code of ['domain.update', 'domain.verify', 'domain.delete', 'domain.transfer', 'domain.share']) {
      expect(member.has(code)).toBe(true);
      expect(operator.has(code)).toBe(true);
    }
    expect(checkDominance('op', operator, 'mem', member).allowed).toBe(true);
  });

  it('신규 Permission 4종이 시드에 반영되고 의도한 역할에만 배정된다', () => {
    const superAdmin = permsByRole.get('SUPER_ADMIN')!;
    const operator = permsByRole.get('OPERATOR')!;
    const member = permsByRole.get('MEMBER')!;

    // SUPER_ADMIN 전용 (파급이 큰 권한)
    for (const code of ['file.share.all', 'governance.freeze.manage']) {
      expect(superAdmin.has(code)).toBe(true);
      expect(operator.has(code)).toBe(false);
    }
    // 거버넌스 조회는 OPERATOR 이상
    expect(operator.has('governance.read')).toBe(true);
    expect(member.has('governance.read')).toBe(false);
    // 도메인 위임은 owned 라 일반회원도 보유 (자기 소유 도메인 한정)
    expect(member.has('domain.share')).toBe(true);
    // 등록은 여전히 DOMAIN_MANAGER 이상
    expect(member.has('domain.create')).toBe(false);
    expect(permsByRole.get('DOMAIN_MANAGER')!.has('domain.create')).toBe(true);
  });
});
