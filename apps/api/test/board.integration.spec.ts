/**
 * 게시판 코어 통합 테스트 (WP-B1, 실 DB).
 *
 * 고정하는 계약:
 *  - **컬렉션 등가성 (RT-22·BINV-3)**: 게시판 목록의 모든 행 = 개별 canAccessBoard ALLOW.
 *    픽스처에 소프트삭제·게시판 DENY·비가시(PRIVATE 비멤버) 포함
 *  - 비가시 게시판·글은 404 은닉 (403 은 존재를 알려준다)
 *  - DENY Grant 는 PUBLIC 게시판도 차단한다 (INV-4 — "숨김은 노출에 우선")
 *  - 멤버십 MODERATOR 등록은 board.moderate Grant 를 코어 단일 통로로 발급한다(§3.4)
 *  - 회원 삭제 시 게시글·댓글이 훅으로 정리된다 (WP-K2 연동 — 커널은 board 를 모른다)
 *  - 자식 있는 댓글 삭제는 tombstone 으로 트리를 보존한다(§4.1)
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
import { PostsService } from '../src/board/posts.service';
import { BoardAttachmentService } from '../src/board/board-attachment.service';
import { StorageService } from '../src/storage/storage.service';
import { UploadSessionService } from '../src/storage/upload-session.service';
import { SettingsService } from '../src/settings/settings.service';
import { CommentsService } from '../src/board/comments.service';
import { BoardOwnerCleanupHook } from '../src/board/board.cleanup';
import { OwnerCleanupRegistry } from '../src/authorization/owner-cleanup';
import { OwnerCleanupWorker } from '../src/members/owner-cleanup.worker';
import { COMMENT_TOMBSTONE } from '../src/board/render';
import { testRegistry } from './helpers/registry';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009984';
const uid = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('게시판 코어 (WP-B1, 실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let policy: BoardPolicyService;
  let boards: BoardsService;
  let posts: PostsService;
  let comments: CommentsService;
  let grants: ResourceGrantService;
  let adminId: string;
  let memberId: string;
  let readPermId: string;

  const snapshot = (id: string, permissions: string[]): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', roles: ['MEMBER'], pv: 1,
    permissions: new Map(permissions.map((c) => [c, { scope: c.includes('manage') || c.endsWith('.all') || c === 'board.read' || c === 'board.write' || c === 'board.comment' ? 'global' : 'owned' }])),
  } as unknown as SubjectSnapshot);

  const MEMBER_CODES = ['board.read', 'board.write', 'board.comment', 'post.update', 'post.delete', 'comment.update', 'comment.delete'];

  const createUser = async (): Promise<string> =>
    (await prisma.user.create({
      data: { tenant_id: TENANT, email: `u-${uid()}@t.local`, password_hash: 'x', name: 'u', status: 'ACTIVE' },
    })).id;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    const audit = new AuditService();
    grants = new ResourceGrantService(audit, new GovernanceFreezeService(p, audit), testRegistry(p));
    policy = new BoardPolicyService(p, new PrismaGrantStore(p));
    boards = new BoardsService(p, audit, policy, grants);
    const storage = new StorageService(new SettingsService(p, new AuditService()));
    const attachments = new BoardAttachmentService(p, audit, storage, new UploadSessionService(p, storage), boards);
    posts = new PostsService(p, audit, boards, attachments);
    comments = new CommentsService(p, audit, boards);

    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'board-test' } });
    for (const code of [...MEMBER_CODES, 'board.moderate', 'board.moderate.all', 'board.manage']) {
      await prisma.permission.upsert({
        where: { code }, update: {},
        create: { code, scope: 'global', module: 'board', description: 't' },
      });
    }
    readPermId = (await prisma.permission.findUniqueOrThrow({ where: { code: 'board.read' } })).id;
    adminId = await createUser();
    memberId = await createUser();
  });

  afterEach(async () => {
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.ownerCleanupJob.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.comment.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.post.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.boardMember.deleteMany({});
    await prisma.board.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.postAttachment.deleteMany({});
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.user.deleteMany({ where: { tenant_id: TENANT, id: { notIn: [adminId, memberId] } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  const makeBoard = (visibility: string, status = 'ACTIVE') =>
    prisma.board.create({
      data: {
        tenant_id: TENANT, slug: `b-${uid()}`.slice(0, 40), name: 'b',
        visibility, status, created_by: adminId,
        ...(status === 'DELETED' ? { deleted_at: new Date() } : {}),
      },
    });

  it('컬렉션 등가성: 목록의 모든 행이 canAccessBoard ALLOW 와 등가 — 제외 픽스처 3종 포함 (BINV-3)', async () => {
    const viewer = snapshot(memberId, MEMBER_CODES);
    const pub = await makeBoard('PUBLIC');
    const deleted = await makeBoard('PUBLIC', 'DELETED'); // ① 소프트 삭제
    const privateBoard = await makeBoard('PRIVATE'); // ② 비가시(비멤버)
    const denied = await makeBoard('PUBLIC'); // ③ PUBLIC + DENY Grant
    await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: memberId, resource_type: 'board', resource_id: denied.id,
        permission_id: readPermId, effect: 'DENY', granted_by: adminId,
      },
    });
    const memberBoard = await makeBoard('RESTRICTED'); // 멤버십으로 포함
    await prisma.boardMember.create({ data: { board_id: memberBoard.id, user_id: memberId } });

    const { items } = await boards.listVisible(viewer, 1, 100);
    const ids = new Set(items.map((b) => b.id));

    expect(ids.has(pub.id)).toBe(true);
    expect(ids.has(memberBoard.id)).toBe(true);
    expect(ids.has(deleted.id)).toBe(false);
    expect(ids.has(privateBoard.id)).toBe(false);
    expect(ids.has(denied.id)).toBe(false); // DENY 는 PUBLIC 도 차단(INV-4)

    // 등가성: 목록의 모든 행은 개별 canAccessBoard 에서 ALLOW 여야 한다
    for (const item of items) {
      const row = await prisma.board.findUniqueOrThrow({ where: { id: item.id } });
      expect(await policy.canAccessBoard(viewer, row)).toBe(true);
    }
    // 역방향: 제외된 픽스처는 개별 판정에서도 거부여야 목록과 등가다
    for (const excluded of [privateBoard, denied]) {
      const row = await prisma.board.findUniqueOrThrow({ where: { id: excluded.id } });
      expect(await policy.canAccessBoard(viewer, row)).toBe(false);
    }
  });

  it('비가시 게시판·글 접근은 404 로 은닉된다 (403 금지 — 존재 오라클 차단)', async () => {
    const viewer = snapshot(memberId, MEMBER_CODES);
    const privateBoard = await makeBoard('PRIVATE');
    const post = await prisma.post.create({
      data: {
        tenant_id: TENANT, board_id: privateBoard.id, owner_id: adminId,
        title: 't', body_md: 'b', body_html: '<p>b</p>',
      },
    });

    await expect(boards.detail(viewer, privateBoard.id)).rejects.toMatchObject({ status: 404 });
    await expect(posts.detail(viewer, post.id)).rejects.toMatchObject({ status: 404 });
    await expect(posts.list(viewer, privateBoard.id)).rejects.toMatchObject({ status: 404 });
  });

  it('멤버십 MODERATOR 등록은 board.moderate Grant 를 코어 단일 통로로 발급한다 (§3.4)', async () => {
    const admin = snapshot(adminId, ['board.manage', 'board.read']);
    const board = await makeBoard('RESTRICTED');
    await boards.addMember(admin, board.id, { userId: memberId, boardRole: 'MODERATOR' });

    const grant = await prisma.resourceGrant.findFirst({
      where: { subject_id: memberId, resource_type: 'board', resource_id: board.id },
      include: { permission: true },
    });
    expect(grant?.permission.code).toBe('board.moderate');
    // 멤버십이 생겼으므로 RESTRICTED 게시판이 보인다
    expect(await policy.canAccessBoard(snapshot(memberId, MEMBER_CODES),
      await prisma.board.findUniqueOrThrow({ where: { id: board.id } }))).toBe(true);
  });

  it('글 작성·수정·삭제가 카운터와 같은 트랜잭션으로 움직인다 (§4.1)', async () => {
    const writer = snapshot(memberId, MEMBER_CODES);
    const board = await makeBoard('PUBLIC');
    const post = await posts.create(writer, board.id, { title: '제목', bodyMd: '<script>x</script>본문' });

    // B1 잠정 렌더: 이스케이프 — 위험 문자열이 그대로 HTML 로 나가지 않는다
    expect(post.bodyHtml).not.toContain('<script>');
    expect(post.bodyHtml).toContain('&lt;script&gt;');

    expect(Number((await prisma.board.findUniqueOrThrow({ where: { id: board.id } })).post_count)).toBe(1);
    await posts.softDelete(writer, post.id);
    expect(Number((await prisma.board.findUniqueOrThrow({ where: { id: board.id } })).post_count)).toBe(0);
  });

  it('자식 있는 댓글 삭제는 tombstone 으로 트리를 보존한다 (§4.1, BINV-4)', async () => {
    const writer = snapshot(memberId, MEMBER_CODES);
    const board = await makeBoard('PUBLIC');
    const post = await posts.create(writer, board.id, { title: 't', bodyMd: 'b' });
    const parent = await comments.create(writer, post.id, { bodyMd: '부모' });
    const child = await comments.create(writer, post.id, { bodyMd: '자식', parentId: parent.id });

    // path 가 트리 순서를 만든다: 부모 '0001' < 자식 '0001.0001'
    expect(child.parentId).toBe(parent.id);
    expect(child.depth).toBe(1);

    await comments.softDelete(writer, parent.id);
    const rows = await comments.list(writer, post.id);
    const tombstone = rows.find((c) => c.id === parent.id);
    expect(tombstone?.bodyHtml).toBe(COMMENT_TOMBSTONE); // 본문은 지워지되 트리는 남는다
    expect(rows.find((c) => c.id === child.id)).toBeDefined();

    // 자식 없는 댓글 삭제는 목록에서 사라진다
    await comments.softDelete(writer, child.id);
    const after = await comments.list(writer, post.id);
    expect(after.find((c) => c.id === child.id)).toBeUndefined();
  });

  it('첨부는 본인 소유 파일만 링크할 수 있다 (R-B7 — 타인 파일 노출 차단)', async () => {
    const writer = snapshot(memberId, MEMBER_CODES);
    const board = await makeBoard('PUBLIC');
    const mine = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: memberId, name: 'mine.png',
        storage_key: `${TENANT}/${uid()}`, size_bytes: 10n, mime_type: 'image/png', checksum: 'c',
      },
    });
    const theirs = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: adminId, name: 'theirs.png',
        storage_key: `${TENANT}/${uid()}`, size_bytes: 10n, mime_type: 'image/png', checksum: 'c',
      },
    });

    const post = await posts.create(writer, board.id, {
      title: 't', bodyMd: 'b', attachmentFileIds: [mine.id],
    });
    expect(post.attachments.map((a) => a.fileId)).toEqual([mine.id]);

    // 타인 파일을 끼워 넣으면 전체 거부 — 어느 것이 남의 것인지도 알려주지 않는다(§10.2)
    await expect(
      posts.create(writer, board.id, { title: 't2', bodyMd: 'b', attachmentFileIds: [mine.id, theirs.id] }),
    ).rejects.toMatchObject({ status: 400 });

    // 글 삭제는 링크만 끊는다 — 파일 실체(타인 소유 규칙)는 건드리지 않는다(§4.1)
    await posts.softDelete(writer, post.id);
    expect((await prisma.file.findUniqueOrThrow({ where: { id: mine.id } })).deleted_at).toBeNull();
  });

  it('회원 삭제 시 게시글·댓글이 훅으로 정리된다 (WP-K2 연동 — 커널 코드는 board 를 모른다)', async () => {
    const doomed = await createUser();
    const writer = snapshot(doomed, MEMBER_CODES);
    const board = await makeBoard('PUBLIC');
    const post = await posts.create(writer, board.id, { title: 't', bodyMd: 'b' });
    await comments.create(writer, post.id, { bodyMd: 'c' });
    await prisma.boardMember.create({ data: { board_id: board.id, user_id: doomed } });

    // 회원 삭제 표식 + 잡 큐잉 (members.service 가 하는 것과 동일)
    await prisma.user.update({ where: { id: doomed }, data: { status: 'DELETED', deleted_at: new Date() } });
    await prisma.ownerCleanupJob.create({ data: { tenant_id: TENANT, user_id: doomed } });

    const hooks = new OwnerCleanupRegistry();
    hooks.register(new BoardOwnerCleanupHook(p));
    await new OwnerCleanupWorker(p, hooks).tick();

    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).deleted_at).not.toBeNull();
    expect(await prisma.comment.count({ where: { owner_id: doomed, deleted_at: null } })).toBe(0);
    expect(await prisma.boardMember.count({ where: { user_id: doomed } })).toBe(0);
    // 카운터도 함께 줄었다
    expect(Number((await prisma.board.findUniqueOrThrow({ where: { id: board.id } })).post_count)).toBe(0);
  });
});
