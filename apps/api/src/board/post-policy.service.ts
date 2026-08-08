import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubjectSnapshot } from '../authorization/types';

export interface PostAccessTarget {
  id: string;
  owner_id: string;
  is_secret: boolean;
}

/**
 * 게시글 정책 훅 (WP-B5, 스펙 §6.5 — 접근개입 모듈의 유일한 편입 지점).
 *
 * 평가기·게시판 코어는 수정하지 않는다(BINV-2). 코어 §7.3 관계형 2차 인가 패턴 —
 * 이 계층은 평가기 밖이라 §14.5-1의 "정책 함수 내부 버그" 사각지대에 들어가므로,
 * 접근 판정 단위 테스트가 필수 산출물이다(board-governance 스펙).
 */
@Injectable()
export class PostPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 비밀글 열람 판정 (§6.5 secret-post) — "숨김은 노출에 우선"(DENY 동형).
   * 허용: 작성자 · board.moderate(해당 게시판 Grant — 평가기 스냅샷이 아니라 Grant 로
   * 판정해야 하나, 여기서는 moderate.all(global)과 지정 열람자만 본다. 게시판 단위
   * moderate 는 호출자가 이미 보유 Grant 로 통과한 문맥에서만 이 함수에 오지 않는다) ·
   * `secret_readers` 지정자.
   *
   * **목록·검색·알림 경로 전부가 이 판정과 등가여야 한다**(BINV-3) — 등가성 테스트가
   * 비밀글 픽스처로 고정한다.
   */
  async canReadPost(subject: SubjectSnapshot, post: PostAccessTarget): Promise<boolean> {
    if (!post.is_secret) return true;
    if (post.owner_id === subject.id) return true;
    if (subject.permissions.has('board.moderate.all')) return true;
    const reader = await this.prisma.postSecretReader.findUnique({
      where: { post_id_user_id: { post_id: post.id, user_id: subject.id } },
    });
    if (reader) return true;
    // 게시판 단위 운영 위임(board.moderate Grant)도 열람 가능 — 운영자가 못 보면 신고 처리 불가
    const moderateGrant = await this.prisma.resourceGrant.findFirst({
      where: {
        subject_id: subject.id,
        resource_type: 'board',
        effect: 'ALLOW',
        permission: { code: 'board.moderate' },
        resource_id: (await this.boardIdOf(post.id)) ?? undefined,
      },
    });
    return moderateGrant !== null;
  }

  /**
   * 수정 판정 (§6.5 co-author) — 작성자 ∨ 공동작성자 ∨ 운영자.
   * **owner_id 는 원작성자로 불변** — 삭제·감사·owned 판정 기준은 원작성자이고,
   * 공동작성자는 편집만 얻는다(R-B12).
   */
  async canEditPost(subject: SubjectSnapshot, post: PostAccessTarget): Promise<boolean> {
    if (post.owner_id === subject.id) return true;
    if (subject.permissions.has('board.moderate.all')) return true;
    const coauthor = await this.prisma.postAuthor.findUnique({
      where: { post_id_user_id: { post_id: post.id, user_id: subject.id } },
    });
    return coauthor !== null;
  }

  /** 비밀글 필터의 쿼리 대응물 — 목록·검색이 canReadPost 와 등가가 되도록 쓰는 조건 */
  async secretScope(subject: SubjectSnapshot): Promise<{
    bypassAll: boolean;
    readablePostIds: string[];
    moderateBoardIds: string[];
  }> {
    if (subject.permissions.has('board.moderate.all')) {
      return { bypassAll: true, readablePostIds: [], moderateBoardIds: [] };
    }
    const [readers, grants] = await Promise.all([
      this.prisma.postSecretReader.findMany({ where: { user_id: subject.id }, select: { post_id: true } }),
      this.prisma.resourceGrant.findMany({
        where: {
          subject_id: subject.id, resource_type: 'board', effect: 'ALLOW',
          permission: { code: 'board.moderate' },
        },
        select: { resource_id: true },
      }),
    ]);
    return {
      bypassAll: false,
      readablePostIds: readers.map((r) => r.post_id),
      moderateBoardIds: grants.map((g) => g.resource_id),
    };
  }

  /** 차단 목록 (§6.5 user-block) — **표시 필터일 뿐 보안 경계가 아니다**. 목록 스코프 전용 */
  async blockedIds(subjectId: string): Promise<string[]> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blocker_id: subjectId }, select: { blocked_id: true },
    });
    return rows.map((r) => r.blocked_id);
  }

  private async boardIdOf(postId: string): Promise<string | null> {
    const post = await this.prisma.post.findUnique({ where: { id: postId }, select: { board_id: true } });
    return post?.board_id ?? null;
  }
}
