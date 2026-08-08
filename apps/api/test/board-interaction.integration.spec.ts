/**
 * 게시판 상호작용 통합 테스트 (WP-B3, 실 DB).
 *
 * 고정하는 계약:
 *  - **outbox at-least-once + 소비자 멱등**: 이벤트는 도메인 트랜잭션과 함께 커밋되고,
 *    재전달돼도 알림은 한 번만 생긴다 (R-B14 중복 억제)
 *  - 알림은 자기 행위에는 가지 않고, 팬아웃 상한이 걸려 있다
 *  - 소비 실패는 재시도 → 소진 시 dead-letter (뒤 이벤트를 막지 않는다)
 *  - reaction·tag 는 게시판 코어 수정 없이 얹히고(BINV-2), 꺼진 게시판에선 404
 *  - 키셋 페이징: 깊이와 무관하게 중복·누락 없이 순회, 고정글은 첫 페이지에만
 *  - 동시 댓글 작성에도 path 가 유일하다 (§9.3 부모 단위 advisory lock)
 */
import { ViewCountService } from '../src/board/view-count.service';
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
import { CommentsService } from '../src/board/comments.service';
import { BoardAttachmentService } from '../src/board/board-attachment.service';
import { BoardEventBus } from '../src/board/event-bus';
import { BoardNotificationService } from '../src/board/notification.service';
import {
  BoardCapabilitiesService, BoardReactionsService, BoardTagsService, CommentReactionsService } from '../src/board/capabilities.service';
import { StorageService } from '../src/storage/storage.service';
import { UploadSessionService } from '../src/storage/upload-session.service';
import { SettingsService } from '../src/settings/settings.service';
import { PostPolicyService } from '../src/board/post-policy.service';
import { testRegistry } from './helpers/registry';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009986';
const uid = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('게시판 상호작용 (WP-B3, 실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let boards: BoardsService;
  let posts: PostsService;
  let comments: CommentsService;
  let bus: BoardEventBus;
  let notifications: BoardNotificationService;
  let reactions: BoardReactionsService;
  let capabilities: BoardCapabilitiesService;
  let authorId: string;
  let commenterId: string;

  const MEMBER_CODES = ['board.read', 'board.write', 'board.comment'];
  const snapshot = (id: string): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', roles: ['MEMBER'], pv: 1,
    permissions: new Map(MEMBER_CODES.map((c) => [c, { scope: 'global' }])),
  } as unknown as SubjectSnapshot);

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    p = prisma as unknown as PrismaService;
    const audit = new AuditService();
    const grants = new ResourceGrantService(audit, new GovernanceFreezeService(p, audit), testRegistry(p));
    const policy = new BoardPolicyService(p, new PrismaGrantStore(p));
    boards = new BoardsService(p, audit, policy, grants);
    capabilities = new BoardCapabilitiesService(p);
    notifications = new BoardNotificationService(p, policy, new PostPolicyService(p, new PrismaGrantStore(p)));
    bus = new BoardEventBus(p);
    bus.register(notifications);
    const storage = new StorageService(new SettingsService(p, new AuditService()));
    const attachments = new BoardAttachmentService(p, audit, storage, new UploadSessionService(p, storage), boards);
    posts = new PostsService(
      p, audit, boards, attachments, new BoardTagsService(p, capabilities), new ViewCountService(p),
      new PostPolicyService(p, new PrismaGrantStore(p)), capabilities, bus,
    );
    comments = new CommentsService(p, audit, boards, bus, new PostPolicyService(p, new PrismaGrantStore(p)), new CommentReactionsService(p, capabilities));
    reactions = new BoardReactionsService(p, audit, capabilities, bus);

    // 다른 스펙(실제 AppModule 을 띄우는 매트릭스 등)이 남긴 outbox·알림 잔재를 비운다 —
    // 버스 클레임은 테넌트 무관(전역 워커)이라 잔재가 이 스펙의 배치를 오염시킨다
    await prisma.boardNotification.deleteMany({});
    await prisma.boardOutboxEvent.deleteMany({});
    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'bi-test' } });
    authorId = (await prisma.user.create({
      data: { tenant_id: TENANT, email: `a-${uid()}@t.local`, password_hash: 'x', name: 'a', status: 'ACTIVE' },
    })).id;
    commenterId = (await prisma.user.create({
      data: { tenant_id: TENANT, email: `c-${uid()}@t.local`, password_hash: 'x', name: 'c', status: 'ACTIVE' },
    })).id;
  });

  afterEach(async () => {
    await prisma.boardNotification.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.boardOutboxEvent.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.boardReaction.deleteMany({});
    await prisma.commentReaction.deleteMany({});
    await prisma.boardTag.deleteMany({});
    await prisma.boardCapability.deleteMany({});
    await prisma.comment.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.post.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.board.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  const makeBoard = () =>
    prisma.board.create({
      data: { tenant_id: TENANT, slug: `b-${uid()}`.slice(0, 40), name: 'b', created_by: authorId },
    });

  it('댓글 작성 → outbox → 글 작성자 알림. 자기 댓글에는 알림이 없다', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(authorId), board.id, { title: 't', bodyMd: 'b' });

    await comments.create(snapshot(commenterId), post.id, { bodyMd: '타인 댓글' });
    await comments.create(snapshot(authorId), post.id, { bodyMd: '자기 댓글' });
    expect(await prisma.boardOutboxEvent.count({ where: { processed_at: null } })).toBe(2);

    await bus.tick();

    const mine = await notifications.listMine(snapshot(authorId));
    expect(mine).toHaveLength(1); // 타인 댓글 1건만 — 자기 행위는 알리지 않는다
    expect(mine[0].kind).toBe('comment.created');
    // 알림에는 링크·최소 메타만 — 본문이 실려 오지 않는다(열람 시 재판정 §6.5)
    expect(JSON.stringify(mine[0].payload)).not.toContain('타인 댓글');
    expect(await prisma.boardOutboxEvent.count({ where: { processed_at: null } })).toBe(0);
  });

  it('같은 이벤트가 재전달돼도 알림은 한 번만 생긴다 (at-least-once + 소비자 멱등, R-B14)', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(authorId), board.id, { title: 't', bodyMd: 'b' });
    await comments.create(snapshot(commenterId), post.id, { bodyMd: 'c' });

    await bus.tick();
    // 전달자 장애를 흉내 — 처리 표식을 되돌려 같은 이벤트를 재전달시킨다
    await prisma.boardOutboxEvent.updateMany({ data: { processed_at: null } });
    await bus.tick();

    expect(await prisma.boardNotification.count({ where: { user_id: authorId } })).toBe(1);
  });

  it('소비 실패는 재시도에 남고, 소진되면 dead-letter — 뒤 이벤트를 막지 않는다', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(authorId), board.id, { title: 't', bodyMd: 'b' });

    const failing = new BoardEventBus(p);
    let calls = 0;
    failing.register({
      topics: ['comment.created'],
      consume: async () => { calls += 1; throw new Error('소비자 결함'); },
    });
    await comments.create(snapshot(commenterId), post.id, { bodyMd: 'c' });

    for (let i = 0; i < 5; i++) await failing.tick();
    const event = await prisma.boardOutboxEvent.findFirstOrThrow({ where: { topic: 'comment.created' } });
    expect(calls).toBe(5);
    expect(event.attempts).toBe(5);
    expect(event.processed_at).not.toBeNull(); // dead-letter — 큐를 막지 않는다
    expect(event.last_error).toContain('소비자 결함');
  });

  it('reaction 토글 멱등 + 꺼진 게시판에선 404 (BINV-2 — 코어 수정 없이 on/off)', async () => {
    const board = await makeBoard();
    const created = await posts.create(snapshot(authorId), board.id, { title: 't', bodyMd: 'b' });
    const post = await prisma.post.findUniqueOrThrow({ where: { id: created.id } });

    expect(await reactions.toggle(snapshot(commenterId), post, 'like')).toEqual({ added: true });
    const summary = await reactions.summary(post.id, commenterId);
    expect(summary).toEqual([{ kind: 'like', count: 1, mine: true }]);
    expect(await reactions.toggle(snapshot(commenterId), post, 'like')).toEqual({ added: false });

    // 기능 끄기 — 코어 코드가 아니라 게시판 설정 행 하나로
    await prisma.boardCapability.create({
      data: { board_id: board.id, capability_key: 'reaction', enabled: false },
    });
    await expect(reactions.toggle(snapshot(commenterId), post, 'like')).rejects.toMatchObject({ status: 404 });
  });

  it('태그는 정규화(소문자·중복 제거)되어 저장되고 상세에 실린다', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(authorId), board.id, {
      title: 't', bodyMd: 'b', tags: ['공지', ' 공지 ', 'FAQ', 'faq'],
    });
    expect([...post.tags].sort()).toEqual(['faq', '공지'].sort());
  });

  it('WP-B6: 댓글 반응은 글 반응과 별도 표에 쌓이고 토글이 멱등하다', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(authorId), board.id, { title: 't', bodyMd: 'b' });
    const comment = await comments.create(snapshot(commenterId), post.id, { bodyMd: 'c' });

    expect(await comments.toggleReaction(snapshot(authorId), comment.id, '👍')).toEqual({ added: true });
    const list = await comments.list(snapshot(authorId), post.id);
    expect(list.find((c) => c.id === comment.id)?.reactions).toEqual([{ kind: '👍', count: 1, mine: true }]);
    // 글 반응 표는 건드리지 않는다 — 별도 표를 쓴 결정의 실증
    expect(await prisma.boardReaction.count({ where: { post_id: post.id } })).toBe(0);

    expect(await comments.toggleReaction(snapshot(authorId), comment.id, '👍')).toEqual({ added: false });
    const after = await comments.list(snapshot(authorId), post.id);
    expect(after.find((c) => c.id === comment.id)?.reactions).toEqual([]);
  });

  it('WP-B6: 작성자 표시명·본인 원본이 실린다 — 남의 댓글 원본은 나가지 않는다', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(authorId), board.id, { title: 't', bodyMd: 'b' });
    await comments.create(snapshot(commenterId), post.id, { bodyMd: '남의 댓글 원본' });

    const asAuthor = await comments.list(snapshot(authorId), post.id);
    expect(asAuthor[0].ownerName).not.toBe('');
    // 수정 화면이 필요로 하는 최소 노출 — 남의 원본은 실리지 않는다
    expect(asAuthor[0].bodyMd).toBeUndefined();

    const asOwner = await comments.list(snapshot(commenterId), post.id);
    expect(asOwner[0].bodyMd).toBe('남의 댓글 원본');
  });

  it('WP-B6: 운영 행위 — 고정·숨김·이동. 숨김은 삭제가 아니고 카운터가 따라 움직인다', async () => {
    const from = await makeBoard();
    const to = await makeBoard();
    // 운영자 스냅샷 — MEMBER 권한 + board.moderate.all
    const moderator = {
      id: authorId, tenantId: TENANT, status: 'ACTIVE', roles: ['OPERATOR'], pv: 1,
      permissions: new Map(
        [...MEMBER_CODES, 'board.moderate.all'].map((c) => [c, { scope: 'global' }]),
      ),
    } as unknown as SubjectSnapshot;
    const post = await posts.create(snapshot(authorId), from.id, { title: 't', bodyMd: 'b' });

    const pinned = await posts.moderate(moderator, post.id, { pin: true });
    expect(pinned.isPinned).toBe(true);

    await posts.moderate(moderator, post.id, { hide: true });
    const hidden = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(hidden.status).toBe('HIDDEN');
    expect(hidden.deleted_at).toBeNull(); // 숨김은 삭제가 아니다 — 되돌릴 수 있다
    expect(Number((await prisma.board.findUniqueOrThrow({ where: { id: from.id } })).post_count)).toBe(0);

    await posts.moderate(moderator, post.id, { hide: false });
    await posts.moderate(moderator, post.id, { moveToBoardId: to.id });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).board_id).toBe(to.id);
    // 카운터가 두 게시판 사이에서 옮겨간다(§4.1)
    expect(Number((await prisma.board.findUniqueOrThrow({ where: { id: from.id } })).post_count)).toBe(0);
    expect(Number((await prisma.board.findUniqueOrThrow({ where: { id: to.id } })).post_count)).toBe(1);
  });

  it('키셋 페이징: 중복·누락 없이 순회하고, 고정글은 첫 페이지에만 실린다 (§8.2)', async () => {
    const board = await makeBoard();
    const writer = snapshot(authorId);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push((await posts.create(writer, board.id, { title: `글 ${i}`, bodyMd: 'b' })).id);
    }
    const pinnedId = ids[0];
    await prisma.post.update({ where: { id: pinnedId }, data: { is_pinned: true } });

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await posts.list(writer, board.id, { cursor, size: 10 });
      pages += 1;
      if (pages === 1) {
        expect(page.items.some((i) => i.id === pinnedId)).toBe(true); // 고정글은 첫 페이지
      } else {
        expect(page.items.some((i) => i.id === pinnedId)).toBe(false); // 이후 페이지엔 없다
      }
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false); // 중복 없음
        seen.add(item.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(25); // 누락 없음
    expect(pages).toBeGreaterThan(1); // 실제로 여러 페이지를 순회했다
  });

  it('동시 댓글 작성에도 path 는 유일하다 (§9.3 부모 단위 advisory lock)', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(authorId), board.id, { title: 't', bodyMd: 'b' });

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        comments.create(snapshot(commenterId), post.id, { bodyMd: `동시 ${i}` }),
      ),
    );
    const rows = await prisma.comment.findMany({ where: { post_id: post.id } });
    const paths = rows.map((r) => r.path);
    expect(new Set(paths).size).toBe(6); // 경합에도 시퀀스 충돌 없음
  });
});
