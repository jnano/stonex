/**
 * 리소스 타입 레지스트리 테스트 (WP-K1).
 *
 * 고정하는 계약:
 *  - 서술자의 table·컬럼명은 SQL 에 들어간다 — 식별자 형식이 아니면 **등록 자체가 실패**한다
 *  - 같은 타입 중복 등록은 실패한다 (나중 등록이 조용히 이기는 것 금지)
 *  - statusesAllowing 은 기존 커널 상수 게이트와 동일하게 동작한다 (회귀 0 — 결합만 끊고 동작 불변)
 *  - **버그 있는 서술자(없는 테이블·컬럼)는 부팅을 막는다**(RT-26) — 불변식(RI-4/5/8)의
 *    정의가 틀린 문자열에 종속된 채 조용히 오작동하는 것보다 부팅 실패가 낫다
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { ResourceTypeRegistry } from '../src/authorization/resource-registry';
import { testRegistry } from './helpers/registry';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const base = {
  ownerColumn: 'owner_id',
  deletedAtColumn: 'deleted_at',
  tenantColumn: 'tenant_id',
  statusColumn: 'status',
  stateGate: { accessible: ['ACTIVE'] },
  load: async () => null,
};

describe('ResourceTypeRegistry — 등록 검증 (단위)', () => {
  const registry = () => new ResourceTypeRegistry(null as unknown as PrismaService);

  it('식별자 형식이 아닌 table·컬럼명은 등록이 거부된다', () => {
    // SQL 에 들어가는 값이다 — 형식 검증이 첫 번째 방어선(RT-26 의 (a))
    expect(() => registry().register({ ...base, type: 'x', table: 'files; DROP TABLE users' }))
      .toThrow(/식별자 형식/);
    expect(() => registry().register({ ...base, type: 'x', table: '"files"' })).toThrow(/식별자 형식/);
    expect(() => registry().register({ ...base, type: 'bad-type', table: 'files' })).toThrow(/식별자 형식/);
    expect(() => registry().register({ ...base, type: 'x', table: 'files', ownerColumn: 'owner id' }))
      .toThrow(/식별자 형식/);
  });

  it('같은 타입의 중복 등록은 거부된다', () => {
    const r = registry();
    r.register({ ...base, type: 'x', table: 'files' });
    // 나중 등록이 조용히 이기면 어느 서술자가 유효한지 코드만 봐서는 알 수 없다
    expect(() => r.register({ ...base, type: 'x', table: 'domains' })).toThrow(/중복 등록/);
  });

  it('statusesAllowing 이 기존 커널 상수 게이트와 동일하게 동작한다 (회귀 0)', () => {
    const r = testRegistry();
    // WP-K1 이전 RESOURCE_STATE_GATE 상수의 동작 그대로 — 결합만 끊고 동작 불변이 DoD 다
    expect(r.statusesAllowing('file', 'file.read')).toEqual(['ACTIVE']);
    expect(r.statusesAllowing('domain', 'domain.read')).toEqual(['UNVERIFIED', 'VERIFIED', 'SUSPENDED']);
    expect(r.statusesAllowing('domain', 'domain.update')).toEqual(['UNVERIFIED', 'VERIFIED']);
    expect(r.statusesAllowing('domain', 'domain.read.all')).toEqual(['UNVERIFIED', 'VERIFIED', 'SUSPENDED']);
    // WP-B1 에서 board 가 등록됐다 — §9.1 경로의 첫 신규 사용자
    expect(r.statusesAllowing('board', 'board.read')).toEqual(['ACTIVE', 'ARCHIVED']);
    // 미등록 타입은 어떤 상태로도 접근 불가 — 목록 쿼리가 빈 집합이 된다
    expect(r.statusesAllowing('wiki', 'wiki.read')).toEqual([]);
  });
});

describe('ResourceTypeRegistry — 스키마 대조 (실 DB, RT-26)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
  });

  afterAll(async () =>
    prisma.$disconnect());

  it('정상 서술자(file·domain)는 실제 스키마 대조를 통과한다', async () => {
    const r = testRegistry(p);
    await expect(r.onModuleInit()).resolves.toBeUndefined();
  });

  it('존재하지 않는 테이블을 가진 서술자는 부팅을 실패시킨다', async () => {
    const r = new ResourceTypeRegistry(p);
    r.register({ ...base, type: 'ghost', table: 'ghost_resources' });
    await expect(r.onModuleInit()).rejects.toThrow(/테이블이 존재하지 않습니다/);
  });

  it('선언된 컬럼이 없는 서술자는 부팅을 실패시킨다', async () => {
    const r = new ResourceTypeRegistry(p);
    // 테이블은 실재하지만 owner 컬럼 오타 — 정규식은 통과하므로 스키마 대조만이 잡는다
    r.register({ ...base, type: 'typo', table: 'files', ownerColumn: 'onwer_id' });
    await expect(r.onModuleInit()).rejects.toThrow(/선언된 컬럼이 없습니다.*onwer_id/);
  });
});
