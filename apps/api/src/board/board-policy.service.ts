import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaGrantStore } from '../authorization/grant.store';
import { SubjectSnapshot } from '../authorization/types';

export interface BoardAccessTarget {
  id: string;
  visibility: string;
  status: string;
}

/**
 * 게시판 접근 정책 (스펙 §3.3 평면 2 — 관계형 2차 인가, 코어 §7.3 패턴).
 *
 * "이 게시판을 이 사람이 볼 수 있는가"는 단일 Permission 으로 표현할 수 없다 —
 * global 이면 비공개가 불가능하고, Grant 로만 하면 공개 게시판이 고카디널리티로 붕괴한다.
 * 그래서 평가기(평면 1)는 "게시판 기능을 쓸 자격"만 보고, 게시판별 가시성은 이 명명
 * 정책 함수가 판정한다. 게시글·댓글 접근은 항상 can() + canAccessBoard 2단 게이트다.
 *
 * 커널 PolicyService 를 수정하지 않고 모듈 폴더에 둔다(D-1) — 같은 패턴, 다른 파일.
 */
@Injectable()
export class BoardPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grantStore: PrismaGrantStore,
  ) {}

  /**
   * 게시판 접근 판정. write=true 면 "글을 쓸 수 있는가" — ARCHIVED 는 읽기만 허용된다.
   *
   * DENY 우선(INV-4): 게시판 단위 DENY Grant(board.read, effect=DENY)는 PUBLIC 이어도
   * 차단한다 — "비공개 게시판을 전역 회수 없이 특정인만 막는" 유일한 수단이다(§3.3).
   */
  async canAccessBoard(
    subject: SubjectSnapshot,
    board: BoardAccessTarget,
    options: { write?: boolean } = {},
  ): Promise<boolean> {
    if (board.status === 'ACTIVE') {
      // 진행
    } else if (board.status === 'ARCHIVED' && !options.write) {
      // 보존 게시판은 읽기만
    } else {
      return false; // BINV-4 — 평가기 1단계와 정합
    }

    const grants = await this.grantStore.findGrants(subject.id, 'board', board.id, 'board.read');
    const now = Date.now();
    const valid = grants.filter((g) => g.expiresAt === null || g.expiresAt.getTime() > now);
    if (valid.some((g) => g.effect === 'DENY')) return false; // DENY 는 모든 경로에 우선

    if (subject.permissions.has('board.moderate.all')) return true; // 플랫폼 운영자
    if (board.visibility === 'PUBLIC') return true;

    // RESTRICTED·PRIVATE — 멤버십 또는 게시판 단위 ALLOW Grant
    if (valid.some((g) => g.effect === 'ALLOW')) return true;
    const membership = await this.prisma.boardMember.findUnique({
      where: { board_id_user_id: { board_id: board.id, user_id: subject.id } },
    });
    return membership !== null;
  }

  /**
   * 접근 가능한 게시판 id 집합의 **쿼리 조건 대응물** (BINV-3 컬렉션 규약).
   *
   * 목록은 게시판을 하나씩 canAccessBoard 에 넣지 않고 행 범위로 거른다. 이 함수가
   * 돌려주는 (허용 id, 차단 id) 집합은 위 판정과 등가여야 하며, 등가성 테스트가 고정한다.
   */
  async visibleBoardScope(subject: SubjectSnapshot): Promise<{
    moderateAll: boolean;
    allowIds: string[];
    denyIds: string[];
    memberBoardIds: string[];
  }> {
    const grants = await this.grantStore.findSubjectGrants(subject.id, 'board');
    const allowIds = grants.filter((g) => g.effect === 'ALLOW').map((g) => g.resourceId);
    const denyIds = grants.filter((g) => g.effect === 'DENY').map((g) => g.resourceId);
    const memberships = await this.prisma.boardMember.findMany({
      where: { user_id: subject.id }, select: { board_id: true },
    });
    return {
      moderateAll: subject.permissions.has('board.moderate.all'),
      allowIds,
      denyIds,
      memberBoardIds: memberships.map((m) => m.board_id),
    };
  }
}
