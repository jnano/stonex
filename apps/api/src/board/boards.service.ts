import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Board } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardPolicyService } from './board-policy.service';
import { BOARD_TYPE_PRESETS, BoardSettings, validateSettings } from './presets';
import { CAPABILITY_KEYS } from './capabilities.service';

export interface BoardSummary {
  id: string;
  slug: string;
  name: string;
  boardType: string;
  visibility: string;
  status: string;
  postCount: number;
  createdAt: string;
  /**
   * 게시판 설정·활성 기능모듈 — **화면이 표현을 정하는 근거**(§5).
   *
   * 이전에는 서버에만 있어 프리셋이 저장까지만 참이고 화면은 전부 같은 모습이었다.
   * 표시 분기의 입력일 뿐 인가가 아니다(BINV-1) — 실제 차단은 서버가 한다.
   */
  settings: BoardSettings;
  capabilities: string[];
}

const toSummary = (b: Board, capabilities: string[] = []): BoardSummary => ({
  id: b.id, slug: b.slug, name: b.name, boardType: b.board_type,
  visibility: b.visibility, status: b.status, postCount: Number(b.post_count),
  createdAt: b.created_at.toISOString(),
  settings: validateSettings(b.settings), capabilities,
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const BOARD_ROLES = ['OWNER', 'MODERATOR', 'MEMBER', 'READER'] as const;
/** 등록 시 board.moderate Grant 를 함께 발급하는 board_role (§3.4).
 *  board_role 은 시스템 역할이 아니라 표시·기본값 전용 문자열이다(BINV-1) —
 *  인가 판정은 여기서 발급되는 Grant(코어 평가기)가 한다. */
const GRANT_ISSUING_BOARD_ROLES: readonly string[] = ['OWNER', 'MODERATOR'];

/**
 * 게시판 관리 (WP-B1 — 스펙 §2·§3.3·§10).
 *
 * 게시판은 회원 소유가 아니다 — 생성·설정은 board.manage(SUPER_ADMIN), 접근은
 * 가시성 정책(BoardPolicyService)이 판정한다. 변경은 감사와 같은 트랜잭션(INV-6).
 */
@Injectable()
export class BoardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: BoardPolicyService,
    private readonly grants: ResourceGrantService,
  ) {}

  /** 게시판별 활성 기능모듈 — 행이 없으면 기본 활성(§6) */
  private async enabledCapabilities(boardIds: string[]): Promise<Map<string, string[]>> {
    if (boardIds.length === 0) return new Map();
    const rows = await this.prisma.boardCapability.findMany({
      where: { board_id: { in: boardIds } },
    });
    const disabled = new Map<string, Set<string>>();
    const explicit = new Map<string, Set<string>>();
    for (const r of rows) {
      const bucket = r.enabled ? explicit : disabled;
      const set = bucket.get(r.board_id) ?? new Set<string>();
      set.add(r.capability_key);
      bucket.set(r.board_id, set);
    }
    return new Map(
      boardIds.map((id) => [
        id,
        CAPABILITY_KEYS.filter((key) => !(disabled.get(id)?.has(key) ?? false)),
      ]),
    );
  }

  /** 접근 가능한 게시판만 (BINV-3 — canAccessBoard 의 쿼리 등가) */
  async listVisible(subject: SubjectSnapshot, page = 1, size = 20): Promise<{ items: BoardSummary[]; total: number }> {
    const take = Math.min(Math.max(size, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;
    const scope = await this.policy.visibleBoardScope(subject);

    const where: Prisma.BoardWhereInput = {
      tenant_id: subject.tenantId,
      deleted_at: null,
      status: { in: ['ACTIVE', 'ARCHIVED'] },
      ...(scope.moderateAll
        ? {}
        : {
            OR: [
              { visibility: 'PUBLIC' },
              { id: { in: [...new Set([...scope.allowIds, ...scope.memberBoardIds])] } },
            ],
          }),
      // DENY 는 모든 경로에 우선한다(INV-4) — moderate.all 이어도 canAccessBoard 와 등가 유지
      ...(scope.denyIds.length > 0 ? { NOT: { id: { in: scope.denyIds } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.board.findMany({ where, orderBy: { created_at: 'asc' }, skip, take }),
      this.prisma.board.count({ where }),
    ]);
    const caps = await this.enabledCapabilities(rows.map((r) => r.id));
    return { items: rows.map((r) => toSummary(r, caps.get(r.id) ?? [])), total };
  }

  /** 단건 조회 — 비가시는 404 은닉(§10.2) */
  async detail(subject: SubjectSnapshot, boardId: string): Promise<BoardSummary> {
    const board = await this.loadAccessible(subject, boardId);
    const caps = await this.enabledCapabilities([board.id]);
    return toSummary(board, caps.get(board.id) ?? []);
  }

  /** 접근 판정 포함 로드 — 게시글·댓글 서비스가 2단 게이트의 정책 절반으로 재사용 */
  async loadAccessible(
    subject: SubjectSnapshot,
    boardId: string,
    options: { write?: boolean } = {},
  ): Promise<Board> {
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board || board.deleted_at || board.tenant_id !== subject.tenantId) throw new NotFoundException();
    const allowed = await this.policy.canAccessBoard(subject, board, options);
    if (!allowed) throw new NotFoundException(); // 존재 은닉 — 403 은 게시판의 존재를 알려준다
    return board;
  }

  async create(
    subject: SubjectSnapshot,
    input: { slug: string; name: string; boardType?: string; visibility?: string },
  ): Promise<BoardSummary> {
    if (!SLUG_RE.test(input.slug)) {
      throw new BadRequestException('slug 는 소문자·숫자·하이픈 3~64자여야 합니다.');
    }
    const board = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.board.findUnique({
        where: { tenant_id_slug: { tenant_id: subject.tenantId, slug: input.slug } },
      });
      if (existing) throw new ConflictException('이미 사용 중인 slug 입니다.');
      const boardType = input.boardType ?? 'FORUM';
      // 프리셋(§5): 특화 게시판 = 코드가 아니라 설정 + 기능모듈 조합. 미지 타입은 FORUM 기본
      const preset = BOARD_TYPE_PRESETS[boardType] ?? BOARD_TYPE_PRESETS.FORUM;
      const created = await tx.board.create({
        data: {
          tenant_id: subject.tenantId,
          slug: input.slug,
          name: input.name,
          board_type: boardType,
          visibility: input.visibility ?? 'PUBLIC',
          settings: preset.settings as unknown as Prisma.InputJsonValue,
          created_by: subject.id,
        },
      });
      // 프리셋 기본 기능모듈: 목록에 없는 것은 명시적으로 끈다 — "미설정=활성" 기본값이
      // 프리셋 의도(FAQ 는 tag 만)를 덮지 않도록 전 카탈로그에 행을 깐다
      await tx.boardCapability.createMany({
        data: CAPABILITY_KEYS.map((key) => ({
          board_id: created.id,
          capability_key: key,
          enabled: preset.capabilitiesDefault.includes(key),
        })),
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'board.create',
        targetType: 'board', targetId: created.id,
        detail: { before: {}, after: { slug: created.slug, visibility: created.visibility } },
      });
      return created;
    });
    return toSummary(board);
  }

  async update(
    subject: SubjectSnapshot,
    boardId: string,
    input: { name?: string; visibility?: string; status?: string },
  ): Promise<BoardSummary> {
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board || board.deleted_at || board.tenant_id !== subject.tenantId) throw new NotFoundException();

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const next = await tx.board.update({
        where: { id: boardId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'board.update',
        targetType: 'board', targetId: boardId,
        detail: {
          before: { name: board.name, visibility: board.visibility, status: board.status },
          after: { name: next.name, visibility: next.visibility, status: next.status },
        },
      });
      return next;
    });
    return toSummary(updated);
  }

  /**
   * 멤버십 추가 (§3.4). MODERATOR 는 시스템이 board.moderate Grant 를 함께 발급한다 —
   * board_role 은 그 Grant 의 파생 표시일 뿐, 인가 판정에 쓰지 않는다(BINV-1).
   */
  async addMember(
    subject: SubjectSnapshot,
    boardId: string,
    input: { userId: string; boardRole?: string },
  ): Promise<void> {
    const role = input.boardRole ?? 'MEMBER';
    if (!(BOARD_ROLES as readonly string[]).includes(role)) {
      throw new BadRequestException(`board_role 은 ${BOARD_ROLES.join('/')} 중 하나여야 합니다.`);
    }
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board || board.deleted_at || board.tenant_id !== subject.tenantId) throw new NotFoundException();
    const target = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!target || target.deleted_at || target.tenant_id !== subject.tenantId) throw new NotFoundException();

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.boardMember.upsert({
        where: { board_id_user_id: { board_id: boardId, user_id: input.userId } },
        update: { board_role: role },
        create: { board_id: boardId, user_id: input.userId, board_role: role },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'board.member.add',
        targetType: 'board', targetId: boardId,
        detail: { before: {}, after: { userId: input.userId, boardRole: role } },
      });
      if (GRANT_ISSUING_BOARD_ROLES.includes(role)) {
        // 운영 위임은 코어 Grant 단일 통로(§5.3) — 화이트리스트·동결·감사가 그대로 적용된다
        await this.grants.create(tx, {
          tenantId: subject.tenantId,
          actorId: subject.id,
          subjectId: input.userId,
          resourceType: 'board',
          resourceId: boardId,
          permissionCodes: ['board.moderate'],
        });
      }
    });
  }

  /** 기능모듈 on/off (§5·§6) — 설정 변경일 뿐 재배포가 없다 */
  async setCapability(
    subject: SubjectSnapshot,
    boardId: string,
    key: string,
    enabled: boolean,
  ): Promise<void> {
    if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(`알 수 없는 기능모듈입니다: ${key}`);
    }
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board || board.deleted_at || board.tenant_id !== subject.tenantId) throw new NotFoundException();
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.boardCapability.upsert({
        where: { board_id_capability_key: { board_id: boardId, capability_key: key } },
        update: { enabled },
        create: { board_id: boardId, capability_key: key, enabled },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'board.capability.set',
        targetType: 'board', targetId: boardId,
        detail: { before: {}, after: { key, enabled } },
      });
    });
  }

  /** 게시판 기능모듈 상태 — 관리 콘솔 표시용 */
  async listCapabilities(subject: SubjectSnapshot, boardId: string): Promise<Array<{ key: string; enabled: boolean }>> {
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board || board.deleted_at || board.tenant_id !== subject.tenantId) throw new NotFoundException();
    const rows = await this.prisma.boardCapability.findMany({ where: { board_id: boardId } });
    const byKey = new Map(rows.map((r) => [r.capability_key, r.enabled]));
    return CAPABILITY_KEYS.map((key) => ({ key, enabled: byKey.get(key) ?? true }));
  }

  async removeMember(subject: SubjectSnapshot, boardId: string, userId: string): Promise<void> {
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board || board.deleted_at || board.tenant_id !== subject.tenantId) throw new NotFoundException();
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.boardMember.deleteMany({ where: { board_id: boardId, user_id: userId } });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'board.member.remove',
        targetType: 'board', targetId: boardId,
        detail: { before: { userId }, after: {} },
      });
    });
  }
}
