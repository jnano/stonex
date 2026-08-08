import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GOVERNANCE_NOTIFIER, GovernanceNotifier } from '../governance/notifier';

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
