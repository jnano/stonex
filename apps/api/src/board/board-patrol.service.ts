import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GOVERNANCE_NOTIFIER, GovernanceNotifier } from '../governance/notifier';
import { COMMENT_TOMBSTONE } from './render';

/** SQL 파라미터로 넘길 tombstone 표식 — 렌더 모듈과 같은 출처(§15.1) */
const TOMBSTONE_HTML = COMMENT_TOMBSTONE;

export interface BriResult {
  id: string;
  title: string;
  violations: number;
  remediated: number;
}

/**
 * 게시판 불변식 순찰 BRI-1~4 (WP-B5, 스펙 §12).
 *
 * 커널 순찰(RI-1~10)과 별도의 **모듈 순찰**이다 — 커널 invariants 는 보호 파일이라
 * 모듈이 편입하려면 커널 수정이 필요한데, 트랙 A 에서 골든·불변식 조각 합성은 트랙 B
 * 장비로 보류됐다(RT-30·RT-37). 모듈이 자기 불변식을 자기 순찰로 지키고, 위반 보고는
 * 코어 GovernanceNotifier 단일 통로를 재사용한다(§14.5).
 *
 *  - BRI-1 고아 첨부: 삭제된 파일을 가리키는 post_attachments — 링크 제거(L-1 성격)
 *  - BRI-2 카운터 정합: post_count·comment_count 재계산 대조 — 자동 보정(§4.1)
 *  - BRI-3 path 무결성: 부모 path 가 자식 path 의 프리픽스가 아니면 트리가 깨진 것 — 보고만
 *  - BRI-4 tenant 일치: 글·댓글의 tenant 가 게시판·글과 어긋나면 교차 테넌트 누수 — 보고만
 *  - BRI-5 고아 tombstone: 붙들 자식이 없는 "삭제된 댓글" — 표식 제거(자동 보정)
 */
@Injectable()
export class BoardPatrolService {
  private readonly logger = new Logger(BoardPatrolService.name);
  lastResults: BriResult[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(GOVERNANCE_NOTIFIER) private readonly notifier: GovernanceNotifier,
  ) {}

  @Interval(600_000) // 10분 — 커널 순찰과 주기를 어긋나게 둔다(부하 분산)
  async patrol(): Promise<BriResult[]> {
    const results: BriResult[] = [];

    // BRI-1 — 고아 첨부: 파일이 소프트 삭제됐는데 링크가 남아 있으면 표시 경로가 깨진다
    const orphanLinks = await this.prisma.$queryRaw<Array<{ post_id: string; file_id: string }>>`
      SELECT pa.post_id, pa.file_id FROM post_attachments pa
        JOIN files f ON f.id = pa.file_id
       WHERE f.deleted_at IS NOT NULL`;
    if (orphanLinks.length > 0) {
      await this.prisma.$executeRaw`
        DELETE FROM post_attachments pa USING files f
         WHERE f.id = pa.file_id AND f.deleted_at IS NOT NULL`;
    }
    results.push({ id: 'BRI-1', title: '고아 첨부', violations: orphanLinks.length, remediated: orphanLinks.length });

    // BRI-2 — 카운터 정합: 비정규화 카운터를 실측과 대조하고 어긋나면 보정한다(§4.1)
    const badPostCounts = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT b.id FROM boards b
       WHERE b.deleted_at IS NULL
         AND b.post_count <> (
           SELECT count(*) FROM posts p
            WHERE p.board_id = b.id AND p.status = 'PUBLISHED' AND p.deleted_at IS NULL)`;
    if (badPostCounts.length > 0) {
      await this.prisma.$executeRaw`
        UPDATE boards b SET post_count = (
          SELECT count(*) FROM posts p
           WHERE p.board_id = b.id AND p.status = 'PUBLISHED' AND p.deleted_at IS NULL)
         WHERE b.id = ANY(${badPostCounts.map((r) => r.id)}::uuid[])`;
    }
    const badCommentCounts = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM posts p
       WHERE p.deleted_at IS NULL
         AND p.comment_count <> (
           SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL)`;
    if (badCommentCounts.length > 0) {
      await this.prisma.$executeRaw`
        UPDATE posts p SET comment_count = (
          SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL)
         WHERE p.id = ANY(${badCommentCounts.map((r) => r.id)}::uuid[])`;
    }
    results.push({
      id: 'BRI-2', title: '카운터 정합',
      violations: badPostCounts.length + badCommentCounts.length,
      remediated: badPostCounts.length + badCommentCounts.length,
    });

    // BRI-3 — path 무결성: 자식 path 는 부모 path + '.' 로 시작해야 한다(§9.1)
    const brokenPaths = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM comments c
        JOIN comments parent ON parent.id = c.parent_id
       WHERE c.path NOT LIKE parent.path || '.%'`;
    results.push({ id: 'BRI-3', title: 'path 무결성', violations: brokenPaths.length, remediated: 0 });

    // BRI-4 — tenant 일치: 논리 참조에 FK 가 tenant 를 강제하지 못한다(코어 RI-5 와 동형)
    const crossTenant = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM posts p JOIN boards b ON b.id = p.board_id WHERE p.tenant_id <> b.tenant_id
      UNION ALL
      SELECT c.id FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.tenant_id <> p.tenant_id`;
    results.push({ id: 'BRI-4', title: 'tenant 일치', violations: crossTenant.length, remediated: 0 });

    /**
     * BRI-5 — 고아 tombstone: 붙들 자식이 없는 "삭제된 댓글".
     *
     * tombstone 은 자식을 붙들어 두기 위해서만 존재하므로, 보이는 자식이 0이면 남을
     * 이유가 없다. 삭제 경로가 연쇄 정리를 하지만(comments.service) 그 경로를 타지
     * 않고 생기는 고아가 있다:
     *  - 정리 로직 도입 **이전**에 삭제된 것 (사건이 없어 촉발되지 않음 — 실제 발생)
     *  - 탈퇴 회원 정리 훅처럼 tombstone 규칙을 거치지 않는 일괄 삭제
     * 한 번 짜고 마는 스크립트 대신 순찰이 스스로 치유하게 둔다.
     *
     * 부모가 고아여도 그 부모가 또 고아일 수 있어 **더 이상 줄지 않을 때까지** 반복한다
     * (한 번만 돌면 조상 방향 연쇄가 한 단계씩만 풀린다).
     */
    let orphanTotal = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const orphans = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM comments t
         WHERE t.deleted_at IS NOT NULL
           AND t.body_html = ${TOMBSTONE_HTML}
           AND NOT EXISTS (
             SELECT 1 FROM comments c
              WHERE c.parent_id = t.id
                AND (c.deleted_at IS NULL OR c.body_html = ${TOMBSTONE_HTML})
           )`;
      if (orphans.length === 0) break;
      await this.prisma.$executeRaw`
        UPDATE comments SET body_html = '', body_md = ''
         WHERE id = ANY(${orphans.map((r) => r.id)}::uuid[])`;
      orphanTotal += orphans.length;
    }
    results.push({
      id: 'BRI-5', title: '고아 tombstone', violations: orphanTotal, remediated: orphanTotal,
    });

    for (const r of results.filter((x) => x.violations > 0 && x.remediated < x.violations)) {
      // 자동 보정 불가 위반은 조용히 쌓이지 않고 운영 채널로 드러난다
      await this.notifier.send({
        level: 'L2',
        title: `게시판 불변식 위반: ${r.id} ${r.title}`,
        body: '자동 보정 불가 — 운영 확인이 필요합니다.',
        detail: { violations: r.violations },
      });
    }
    this.lastResults = results;
    return results;
  }
}
