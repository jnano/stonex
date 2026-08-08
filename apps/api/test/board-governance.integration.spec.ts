/**
 * 게시판 특화·거버넌스 통합 테스트 (WP-B5, 실 DB) — 게시판 완료 판정의 실증부.
 *
 * 고정하는 계약:
 *  - **R-B11**: 비밀글은 목록·검색·알림 어디에도 새지 않는다. 작성자·지정 열람자·운영자만 본다
 *  - **R-B12**: 공동작성자는 편집만 얻는다 — owner_id 불변, 제3자는 수정 불가(404)
 *  - **R-B13**: 차단은 표시 필터다 — 차단해도 상대는 여전히 내 글을 본다(보안 경계 아님)
 *  - **R-B15**: 집단 신고의 자동 발동 상한은 임시 숨김. 삭제·복구는 운영자의 명시 결정
 *  - **§5**: 프리셋은 코드 재배포 없이 설정+기능모듈 조합으로 특화 게시판을 만든다
 *  - **§12**: BRI 순찰이 고아 첨부를 정리하고 카운터를 보정한다
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
import { GovernanceAlert, GovernanceNotifier } from '../src/governance/notifier';
import { BoardPolicyService } from '../src/board/board-policy.service';
import { PostPolicyService } from '../src/board/post-policy.service';
import { BoardsService } from '../src/board/boards.service';
import { PostsService } from '../src/board/posts.service';
import { CommentsService } from '../src/board/comments.service';
import { BoardAttachmentService } from '../src/board/board-attachment.service';
import { BoardEventBus } from '../src/board/event-bus';
import { BoardNotificationService } from '../src/board/notification.service';
import { BoardSearchService } from '../src/board/search.service';
import { BoardReportsService } from '../src/board/reports.service';
import { BoardPatrolService } from '../src/board/board-patrol.service';
import { ViewCountService } from '../src/board/view-count.service';
import { BoardCapabilitiesService, BoardTagsService } from '../src/board/capabilities.service';
import { StorageService } from '../src/storage/storage.service';
import { UploadSessionService } from '../src/storage/upload-session.service';
import { SettingsService } from '../src/settings/settings.service';
import { testRegistry } from './helpers/registry';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다.');

const TENANT = '00000000-0000-0000-0000-000000009990';
const uid = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

class CollectingNotifier implements GovernanceNotifier {
  alerts: GovernanceAlert[] = [];
  async send(alert: GovernanceAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

describe('게시판 특화·거버넌스 (WP-B5, 실 DB)', () => {
  let prisma: PrismaClient;
  let p: PrismaService;
  let boards: BoardsService;
  let posts: PostsService;
  let comments: CommentsService;
  let search: BoardSearchService;
  let reports: BoardReportsService;
  let bus: BoardEventBus;
  let notifications: BoardNotificationService;
  let patrol: BoardPatrolService;
  let notifier: CollectingNotifier;
  let author: string;
  let reader: string;
  let outsider: string;
  let adminUser: string;

  const MEMBER_CODES = ['board.read', 'board.write', 'board.comment'];
  const snapshot = (id: string, extra: string[] = []): SubjectSnapshot => ({
    id, tenantId: TENANT, status: 'ACTIVE', roles: ['MEMBER'], pv: 1,
    permissions: new Map([...MEMBER_CODES, ...extra].map((c) => [c, { scope: 'global' }])),
  } as unknown as SubjectSnapshot);

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
    const grants = new ResourceGrantService(audit, new GovernanceFreezeService(p, audit), testRegistry(p));
    const boardPolicy = new BoardPolicyService(p, new PrismaGrantStore(p));
    const postPolicy = new PostPolicyService(p, new PrismaGrantStore(p));
    const capabilities = new BoardCapabilitiesService(p);
    boards = new BoardsService(p, audit, boardPolicy, grants);
    notifications = new BoardNotificationService(p, boardPolicy, postPolicy);
    bus = new BoardEventBus(p);
    bus.register(notifications);
    const storage = new StorageService(new SettingsService(p, new AuditService()));
    const attachments = new BoardAttachmentService(p, audit, storage, new UploadSessionService(p, storage), boards);
    posts = new PostsService(
      p, audit, boards, attachments, new BoardTagsService(p, capabilities), new ViewCountService(p),
      postPolicy, capabilities, bus,
    );
    comments = new CommentsService(p, audit, boards, bus, postPolicy);
    search = new BoardSearchService(p, boards, postPolicy);
    reports = new BoardReportsService(p, audit, capabilities);
    notifier = new CollectingNotifier();
    patrol = new BoardPatrolService(p, notifier);

    await prisma.boardNotification.deleteMany({});
    await prisma.boardOutboxEvent.deleteMany({});
    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'gov-test' } });
    author = await createUser();
    reader = await createUser();
    outsider = await createUser();
    adminUser = await createUser();
  });

  afterEach(async () => {
    await prisma.boardNotification.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.boardOutboxEvent.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.boardReport.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.postSecretReader.deleteMany({});
    await prisma.postAuthor.deleteMany({});
    await prisma.userBlock.deleteMany({});
    await prisma.boardCapability.deleteMany({});
    await prisma.postAttachment.deleteMany({});
    await prisma.comment.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.post.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.board.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  const makeBoard = (boardType = 'FORUM') =>
    boards.create(snapshot(adminUser, ['board.manage', 'board.moderate.all']), {
      slug: `b-${uid()}`.slice(0, 40), name: 'b', boardType,
    });

  it('R-B11: 비밀글은 목록·검색·상세·알림 어디에도 새지 않는다 — 지정 열람자·작성자·운영자만', async () => {
    const board = await makeBoard();
    const secret = await posts.create(snapshot(author), board.id, {
      title: '기밀 예산안 검토', bodyMd: '유출 금지 본문', secret: true, secretReaderIds: [reader],
    });
    await posts.create(snapshot(author), board.id, { title: '공개 글', bodyMd: 'x' });

    // 목록: 외부인에게는 안 보이고, 작성자·지정 열람자·운영자에게는 보인다
    const outsiderList = await posts.list(snapshot(outsider), board.id);
    expect(outsiderList.items.some((i) => i.id === secret.id)).toBe(false);
    for (const who of [author, reader]) {
      const list = await posts.list(snapshot(who), board.id);
      expect(list.items.some((i) => i.id === secret.id)).toBe(true);
    }
    const modList = await posts.list(snapshot(outsider, ['board.moderate.all']), board.id);
    expect(modList.items.some((i) => i.id === secret.id)).toBe(true);

    // 검색: 같은 등가 — 비밀글 픽스처 필수(BINV-3)
    const outsiderSearch = await search.search(snapshot(outsider), board.id, '기밀 예산');
    expect(outsiderSearch).toEqual([]);
    const readerSearch = await search.search(snapshot(reader), board.id, '기밀 예산');
    expect(readerSearch.map((r) => r.id)).toEqual([secret.id]);

    // 상세: 404 은닉
    await expect(posts.detail(snapshot(outsider), secret.id)).rejects.toMatchObject({ status: 404 });
    await expect(posts.detail(snapshot(reader), secret.id)).resolves.toMatchObject({ id: secret.id });

    // 알림: 비밀글에 지정 열람자가 댓글 → 작성자에게는 가되, 접근 불가 멘션 대상에게는 안 간다
    await comments.create(snapshot(reader), secret.id, { bodyMd: '검토 의견' });
    await bus.tick();
    expect(await prisma.boardNotification.count({ where: { user_id: author } })).toBe(1);
    expect(await prisma.boardNotification.count({ where: { user_id: outsider } })).toBe(0);
  });

  it('mention: 접근 불가 대상에게는 알림이 가지 않는다 — 알림이 비밀글 존재를 유출하지 않음(§6.5)', async () => {
    const board = await makeBoard();
    const outsiderEmail = (await prisma.user.findUniqueOrThrow({ where: { id: outsider } })).email;
    const readerEmail = (await prisma.user.findUniqueOrThrow({ where: { id: reader } })).email;

    await posts.create(snapshot(author), board.id, {
      title: '비밀 멘션', bodyMd: `@${readerEmail} @${outsiderEmail} 확인 바랍니다`,
      secret: true, secretReaderIds: [reader],
    });
    await bus.tick();

    // 지정 열람자는 멘션 알림을 받고, 외부인은 비밀글이 존재한다는 사실조차 받지 못한다
    expect(await prisma.boardNotification.count({ where: { user_id: reader, kind: 'mention.created' } })).toBe(1);
    expect(await prisma.boardNotification.count({ where: { user_id: outsider } })).toBe(0);
  });

  it('R-B12: 공동작성자는 편집만 얻는다 — owner_id 불변, 제3자 수정 불가', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(author), board.id, { title: '공동 문서', bodyMd: 'v1' });
    await posts.setCoAuthors(snapshot(author), post.id, [reader]);

    // 공동작성자 수정 가능 — owner_id 는 원작성자 그대로(삭제·감사·owned 기준 불변)
    const edited = await posts.update(snapshot(reader), post.id, { bodyMd: 'v2 (공동 편집)' });
    expect(edited.bodyMd).toBe('v2 (공동 편집)');
    expect(edited.ownerId).toBe(author);

    // 제3자는 404 은닉, 공동작성자 지정은 원작성자만
    await expect(posts.update(snapshot(outsider), post.id, { bodyMd: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(posts.setCoAuthors(snapshot(reader), post.id, [outsider])).rejects.toMatchObject({ status: 404 });
    // 삭제는 owned — 공동작성자도 불가(코어 Guard 영역이므로 여기서는 정책만 확인)
  });

  it('R-B13: 차단은 표시 필터다 — 내 목록에서 상대가 사라질 뿐, 상대는 여전히 내 글을 본다', async () => {
    const board = await makeBoard();
    const myPost = await posts.create(snapshot(author), board.id, { title: '내 글', bodyMd: 'x' });
    const theirPost = await posts.create(snapshot(outsider), board.id, { title: '상대 글', bodyMd: 'x' });
    await prisma.userBlock.create({ data: { blocker_id: author, blocked_id: outsider } });

    const myList = await posts.list(snapshot(author), board.id);
    expect(myList.items.some((i) => i.id === theirPost.id)).toBe(false); // 내 화면에서 숨김

    // 보안 경계가 아니다: 차단당한 쪽은 내 글을 여전히 본다
    const theirList = await posts.list(snapshot(outsider), board.id);
    expect(theirList.items.some((i) => i.id === myPost.id)).toBe(true);
    await expect(posts.detail(snapshot(outsider), myPost.id)).resolves.toMatchObject({ id: myPost.id });
  });

  it('R-B15: 신고 5건 → 임시 숨김(삭제 아님) → 기각 시 복구, 승인 시 삭제. 1인 중복 신고 차단', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(author), board.id, { title: '신고 대상', bodyMd: 'x' });

    await expect(reports.report(snapshot(author), post.id, '자기 신고')).rejects.toMatchObject({ status: 400 });
    const reporters = await Promise.all(Array.from({ length: 5 }, () => createUser()));
    for (const r of reporters) await reports.report(snapshot(r), post.id, '부적절');
    await expect(reports.report(snapshot(reporters[0]), post.id, '중복')).rejects.toMatchObject({ status: 400 });

    // 자동 발동의 상한: HIDDEN — 삭제가 아니다
    const hidden = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(hidden.status).toBe('HIDDEN');
    expect(hidden.deleted_at).toBeNull();

    // 운영 기각 → 복구
    const open = await reports.listOpen(snapshot(adminUser, ['board.moderate.all']));
    expect(open[0].openCountForPost).toBe(5);
    await reports.resolve(snapshot(adminUser, ['board.moderate.all']), open[0].id, false);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('PUBLISHED');

    // 재신고 후 운영 승인 → 그때에야 삭제
    const again = await createUser();
    await reports.report(snapshot(again), post.id, '재신고');
    const open2 = await reports.listOpen(snapshot(adminUser, ['board.moderate.all']));
    await reports.resolve(snapshot(adminUser, ['board.moderate.all']), open2[0].id, true);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).deleted_at).not.toBeNull();
  });

  it('§5 프리셋: 코드 재배포 없이 5종 게시판이 설정+기능모듈 조합으로 만들어진다', async () => {
    // 5종 전부 생성되고, 프리셋별 특성이 실제 동작으로 드러난다
    const notice = await makeBoard('NOTICE');
    const faq = await makeBoard('FAQ');
    const forum = await makeBoard('FORUM');
    await makeBoard('QNA');
    await makeBoard('GALLERY');

    // NOTICE: write_policy=MODERATOR — 일반 회원 작성 403 (게시판은 보이므로 은닉하지 않는다)
    await expect(posts.create(snapshot(author), notice.id, { title: 'x', bodyMd: 'x' }))
      .rejects.toMatchObject({ status: 403 });
    // 운영자는 작성 가능
    await expect(posts.create(snapshot(adminUser, ['board.moderate.all']), notice.id, { title: '공지', bodyMd: 'x' }))
      .resolves.toMatchObject({ title: '공지' });

    // FAQ: 댓글 off — 작성 404 (기능이 없는 것으로 보인다)
    const faqPost = await posts.create(snapshot(adminUser, ['board.moderate.all']), faq.id, { title: 'Q', bodyMd: 'A' });
    await expect(comments.create(snapshot(author), faqPost.id, { bodyMd: 'x' }))
      .rejects.toMatchObject({ status: 404 });
    // FAQ 프리셋은 report 미포함 — 꺼진 기능모듈은 404
    await expect(reports.report(snapshot(author), faqPost.id, 'x')).rejects.toMatchObject({ status: 404 });

    // FORUM: 댓글 무제한 + report 활성
    const forumPost = await posts.create(snapshot(author), forum.id, { title: 'f', bodyMd: 'x' });
    await expect(comments.create(snapshot(reader), forumPost.id, { bodyMd: 'ok' })).resolves.toBeDefined();
    await expect(reports.report(snapshot(reader), forumPost.id, '신고')).resolves.toEqual({ ok: true });
  });

  it('§12 BRI 순찰: 고아 첨부를 정리하고 카운터를 보정하며, 보정 불가 위반은 보고된다', async () => {
    const board = await makeBoard();
    const post = await posts.create(snapshot(author), board.id, { title: 'p', bodyMd: 'x' });

    // 고아 첨부: 파일을 소프트 삭제한 채 링크만 남긴다
    const file = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: author, name: 'f.png', storage_key: `${TENANT}/${uid()}`,
        size_bytes: 1n, mime_type: 'image/png', checksum: 'c', status: 'DELETED', deleted_at: new Date(),
      },
    });
    await prisma.postAttachment.create({ data: { post_id: post.id, file_id: file.id } });
    // 카운터 어긋남 주입
    await prisma.board.update({ where: { id: board.id }, data: { post_count: 999 } });
    // 교차 테넌트 주입(보고 전용 위반)
    const otherTenant = '00000000-0000-0000-0000-000000009991';
    await prisma.tenant.upsert({ where: { id: otherTenant }, update: {}, create: { id: otherTenant, name: 'x' } });
    const alien = await prisma.post.create({
      data: {
        tenant_id: otherTenant, board_id: board.id, owner_id: author,
        title: 'alien', body_md: 'x', body_html: '<p>x</p>',
      },
    });

    const results = await patrol.patrol();
    expect(results.find((r) => r.id === 'BRI-1')).toMatchObject({ violations: 1, remediated: 1 });
    expect(await prisma.postAttachment.count({ where: { post_id: post.id } })).toBe(0);
    expect(Number((await prisma.board.findUniqueOrThrow({ where: { id: board.id } })).post_count)).toBe(2); // 실측 보정
    expect(results.find((r) => r.id === 'BRI-4')!.violations).toBeGreaterThan(0);
    expect(notifier.alerts.some((a) => a.title.includes('BRI-4'))).toBe(true); // 조용히 쌓이지 않는다

    await prisma.post.delete({ where: { id: alien.id } });
  });
});
