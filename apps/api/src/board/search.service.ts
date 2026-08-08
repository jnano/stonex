import { Injectable } from '@nestjs/common';
import { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardsService } from './boards.service';
import { PostPolicyService } from './post-policy.service';
import { PostSummary } from './posts.service';

/**
 * 한국어 검색 어댑터 (WP-B4, 스펙 §8.1).
 *
 * GD-3 결정은 pg_bigm 이었으나 **환경 실측 결과 로컬·CI 어디에도 없다**(별도 빌드 필요 —
 * "운영 부담 낮음" 취지에 오히려 반한다). 같은 취지를 내장 contrib pg_trgm 이 충족한다:
 * ILIKE '%…%' 부분일치를 trgm GIN 인덱스가 가속하고, 한국어는 형태소 분석 없이도
 * 음절 단위 부분일치로 동작한다. 엔진 교체는 이 함수 하나로 국소화돼 있다 —
 * pg_bigm·mecab-ko 전환 시 어댑터와 인덱스만 바꾼다.
 */
const searchCondition = (query: string): Prisma.Sql =>
  Prisma.sql`(p.title ILIKE ${'%' + query + '%'} OR p.body_md ILIKE ${'%' + query + '%'})`;

/**
 * 게시판 검색 (스펙 §8.1, R-B8).
 *
 * 검색은 **게시판 단위**다(§10.1 — GET /boards/:id/search): 게시판 접근 판정
 * (canAccessBoard)을 먼저 통과해야 하므로, 접근 불가 게시판의 글이 검색으로 새는
 * 경로가 구조적으로 없다. 그 위에 목록과 동일한 행 조건(PUBLISHED·비삭제·탈퇴자
 * 제외)을 결합한다 — 목록이 숨기는 것을 검색이 드러내면 안 된다(BINV-3 등가).
 */
@Injectable()
export class BoardSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly boards: BoardsService,
    private readonly policy: PostPolicyService,
  ) {}

  async search(
    subject: SubjectSnapshot,
    boardId: string,
    query: string,
    limit = 20,
  ): Promise<PostSummary[]> {
    await this.boards.loadAccessible(subject, boardId); // 평면 2 — 비가시 게시판은 404
    const trimmed = query.trim();
    if (trimmed.length < 2) return []; // 1자 검색은 전량 스캔에 가깝다 — 최소 2자
    // 비밀글(R-B11): 검색은 목록과 같은 스코프 — 검색이 비밀글의 존재를 드러내면 안 된다
    const secret = await this.policy.secretScope(subject);
    const blocked = await this.policy.blockedIds(subject.id);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; board_id: string; owner_id: string; title: string;
        is_pinned: boolean; comment_count: bigint; view_count: bigint; status: string;
        is_secret: boolean; created_at: Date;
      }>
    >`
      SELECT p.id, p.board_id, p.owner_id, p.title, p.is_pinned, p.comment_count, p.view_count, p.status, p.is_secret, p.created_at
        FROM posts p
       WHERE p.board_id = ${boardId}::uuid
         AND p.deleted_at IS NULL
         AND (p.status = 'PUBLISHED' OR (p.status = 'DRAFT' AND p.owner_id = ${subject.id}::uuid))
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.owner_id AND u.deleted_at IS NOT NULL)
         AND (${secret.bypassAll}::boolean OR p.is_secret = false OR p.owner_id = ${subject.id}::uuid
              OR p.id = ANY(${secret.readablePostIds}::uuid[])
              OR p.board_id = ANY(${secret.moderateBoardIds}::uuid[]))
         AND NOT (p.owner_id = ANY(${blocked}::uuid[]))
         AND ${searchCondition(trimmed)}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${Math.min(Math.max(limit, 1), 50)}`;

    return rows.map((p) => ({
      id: p.id, boardId: p.board_id, ownerId: p.owner_id, title: p.title,
      isPinned: p.is_pinned, commentCount: Number(p.comment_count), viewCount: Number(p.view_count),
      status: p.status, isSecret: p.is_secret, createdAt: p.created_at.toISOString(),
    }));
  }
}
