/**
 * 게시판 검색·조회수 통합 테스트 (WP-B4, 실 DB).
 *
 * 고정하는 계약:
 *  - **R-B8**: 접근 불가 게시판의 글은 검색으로 새지 않는다(404) — 검색이 목록의
 *    은닉(HIDDEN·DELETED·타인 DRAFT·탈퇴자)을 드러내지도 않는다
 *  - 한국어 부분일치가 동작한다 (GD-3 — pg_trgm 어댑터, pg_bigm 은 환경 부재로 대체)
 *  - 조회수는 요청 경로에서 DB 를 쓰지 않고, 플러시가 증분 반영한다
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { GovernanceFreezeService } from '../src/governance/freeze.service';
import { ResourceGrantService } from '../src/authorization/resource-grant.service';
import { PrismaGrantStore } from '../src/authorization/grant.store';
import { SubjectSnapshot } from '../src/authorization/types';
import { BoardPolicyService } from '../src/board/board-policy.service';
import { BoardsService } from '../src/board/boards.service';
import { BoardSearchService } from '../src/board/search.service';
import { ViewCountService } from '../src/board/view-count.service';
import { testRegistry } from './helpers/registry';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009988';
const uid = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('게시판 검색·조회수 (WP-B4, 실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let boards: BoardsService;
  let search: BoardSearchService;
  let userId: string;
  let otherId: string;

  const snapshot = (id: string): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', roles: ['MEMBER'], pv: 1,
    permissions: new Map([['board.read', { scope: 'global' }]]),
  } as unknown as SubjectSnapshot);

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    const audit = new AuditService();
    const grants = new ResourceGrantService(audit, new GovernanceFreezeService(p, audit), testRegistry(p));
    boards = new BoardsService(p, audit, new BoardPolicyService(p, new PrismaGrantStore(p)), grants);
    search = new BoardSearchService(p, boards);

    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'search-test' } });
    userId = (await prisma.user.create({
      data: { tenant_id: TENANT, email: `u-${uid()}@t.local`, password_hash: 'x', name: 'u', status: 'ACTIVE' },
    })).id;
    otherId = (await prisma.user.create({
      data: { tenant_id: TENANT, email: `o-${uid()}@t.local`, password_hash: 'x', name: 'o', status: 'ACTIVE' },
    })).id;
  });

  afterEach(async () => {
    await prisma.post.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.board.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  const makeBoard = (visibility = 'PUBLIC') =>
    prisma.board.create({
      data: { tenant_id: TENANT, slug: `b-${uid()}`.slice(0, 40), name: 'b', visibility, created_by: userId },
    });
  const makePost = (boardId: string, title: string, body: string, extra: Record<string, unknown> = {}) =>
    prisma.post.create({
      data: {
        tenant_id: TENANT, board_id: boardId, owner_id: userId,
        title, body_md: body, body_html: `<p>${body}</p>`, ...extra,
      },
    });

  it('한국어 부분일치가 동작한다 — 제목·본문 (pg_trgm 어댑터)', async () => {
    const board = await makeBoard();
    await makePost(board.id, '권한 시스템 설계 회고', '본문입니다');
    await makePost(board.id, '다른 글', '마이크로커널 아키텍처를 논한다');
    await makePost(board.id, '무관한 글', '아무 내용');

    const byTitle = await search.search(snapshot(userId), board.id, '시스템 설계');
    expect(byTitle.map((r) => r.title)).toEqual(['권한 시스템 설계 회고']);

    const byBody = await search.search(snapshot(userId), board.id, '마이크로커널');
    expect(byBody.map((r) => r.title)).toEqual(['다른 글']);

    expect(await search.search(snapshot(userId), board.id, '존재하지않는어절')).toEqual([]);
  });

  it('접근 불가 게시판의 검색은 404 — 결과 0건이 아니라 존재 은닉이다 (R-B8)', async () => {
    const privateBoard = await makeBoard('PRIVATE');
    await makePost(privateBoard.id, '비공개 기밀 문서', '유출되면 안 되는 내용');

    await expect(search.search(snapshot(otherId), privateBoard.id, '기밀'))
      .rejects.toMatchObject({ status: 404 });
  });

  it('검색이 목록의 은닉을 드러내지 않는다 — HIDDEN·DELETED·타인 DRAFT·탈퇴자 글 (BINV-3 등가)', async () => {
    const board = await makeBoard();
    await makePost(board.id, '검색가능 정상 글', 'x');
    await makePost(board.id, '검색불가 숨김 글', 'x', { status: 'HIDDEN' });
    await makePost(board.id, '검색불가 삭제 글', 'x', { status: 'DELETED', deleted_at: new Date() });
    await makePost(board.id, '검색불가 임시 글', 'x', { status: 'DRAFT', owner_id: otherId });
    const ghost = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `g-${uid()}@t.local`, password_hash: 'x', name: 'g',
        status: 'DELETED', deleted_at: new Date(),
      },
    });
    await makePost(board.id, '검색불가 탈퇴자 글', 'x', { owner_id: ghost.id });

    const rows = await search.search(snapshot(userId), board.id, '검색');
    expect(rows.map((r) => r.title)).toEqual(['검색가능 정상 글']);
  });

  it('조회수는 요청 경로에서 DB 를 쓰지 않고, 플러시가 증분 반영한다', async () => {
    const board = await makeBoard();
    const post = await makePost(board.id, '조회수 글', 'x');
    const views = new ViewCountService(p);

    views.bump(post.id);
    views.bump(post.id);
    views.bump(post.id);
    // bump 는 동기 반환(메모리뿐) — 이 시점 DB 는 0 이어야 한다
    expect(Number((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).view_count)).toBe(0);

    await views.flush();
    expect(Number((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).view_count)).toBe(3);

    // 플러시 후 버퍼는 비어 있다 — 재플러시가 중복 가산하지 않는다
    await views.flush();
    expect(Number((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).view_count)).toBe(3);
  });
});
