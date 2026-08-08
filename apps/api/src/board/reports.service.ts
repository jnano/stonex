import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardCapabilitiesService } from './capabilities.service';

export interface ReportView {
  id: string;
  postId: string;
  postTitle: string;
  reason: string;
  status: string;
  createdAt: string;
  openCountForPost: number;
}

/** 자동 임시 숨김 문턱 — 서로 다른 신고자 수 기준(같은 사람 중복은 유니크가 막는다) */
const AUTO_HIDE_THRESHOLD = 5;

/**
 * 신고·블라인드 (WP-B5, 기능모듈 report — R-B15).
 *
 * **집단 신고는 글을 삭제하지 못한다.** 자동 발동의 상한은 "임시 숨김(HIDDEN) + 운영
 * 확인 대기"다 — 조직적 신고가 삭제 버튼이 되면 신고 기능 자체가 검열 도구가 된다.
 * 삭제(UPHELD)·복구(DISMISSED)는 운영자의 명시적 결정이며 감사에 남는다.
 */
@Injectable()
export class BoardReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly capabilities: BoardCapabilitiesService,
  ) {}

  async report(subject: SubjectSnapshot, postId: string, reason: string): Promise<{ ok: true }> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deleted_at || post.status === 'DELETED') throw new NotFoundException();
    await this.capabilities.assertEnabled(post.board_id, 'report');
    if (post.owner_id === subject.id) {
      throw new BadRequestException('자기 글은 신고할 수 없습니다.');
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.boardReport
        .create({
          data: { tenant_id: subject.tenantId, post_id: postId, reporter_id: subject.id, reason },
        })
        .catch((error: { code?: string }) => {
          if (error.code === 'P2002') {
            throw new BadRequestException('이미 신고한 글입니다.'); // 1인 반복 신고로 문턱 넘기기 차단
          }
          throw error;
        });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'board.report.create',
        targetType: 'post', targetId: postId, detail: { before: {}, after: {} }, // 사유는 신고 테이블에만
      });

      const openCount = await tx.boardReport.count({ where: { post_id: postId, status: 'OPEN' } });
      if (openCount >= AUTO_HIDE_THRESHOLD && post.status === 'PUBLISHED') {
        // 자동 발동의 상한: 임시 숨김. 삭제가 아니다(R-B15) — 운영 결정을 기다린다
        await tx.post.update({ where: { id: postId }, data: { status: 'HIDDEN' } });
        await this.audit.record(tx, {
          tenantId: subject.tenantId, actorId: null, action: 'board.report.auto_hide',
          targetType: 'post', targetId: postId,
          detail: { before: { status: 'PUBLISHED' }, after: { status: 'HIDDEN', openReports: openCount } },
        });
      }
    });
    return { ok: true };
  }

  /** 운영 목록 — OPEN 우선, 글 단위 신고 수 포함 */
  async listOpen(subject: SubjectSnapshot): Promise<ReportView[]> {
    const rows = await this.prisma.boardReport.findMany({
      where: { tenant_id: subject.tenantId, status: 'OPEN' },
      orderBy: { created_at: 'asc' },
      take: 100,
    });
    const postIds = [...new Set(rows.map((r) => r.post_id))];
    const posts = await this.prisma.post.findMany({ where: { id: { in: postIds } } });
    const counts = await this.prisma.boardReport.groupBy({
      by: ['post_id'], where: { post_id: { in: postIds }, status: 'OPEN' }, _count: true,
    });
    const titleById = new Map(posts.map((p) => [p.id, p.title]));
    const countById = new Map(counts.map((c) => [c.post_id, c._count]));
    return rows.map((r) => ({
      id: r.id, postId: r.post_id, postTitle: titleById.get(r.post_id) ?? '(삭제된 글)',
      reason: r.reason, status: r.status, createdAt: r.created_at.toISOString(),
      openCountForPost: countById.get(r.post_id) ?? 0,
    }));
  }

  /**
   * 운영 결정 (board.moderate.all 게이트는 컨트롤러).
   * uphold: 글 소프트 삭제 + 그 글의 OPEN 신고 전부 UPHELD.
   * dismiss: OPEN 신고 전부 기각 + 자동 숨김이었다면 PUBLISHED 복구.
   */
  async resolve(subject: SubjectSnapshot, reportId: string, uphold: boolean): Promise<{ ok: true }> {
    const report = await this.prisma.boardReport.findUnique({ where: { id: reportId } });
    if (!report || report.tenant_id !== subject.tenantId || report.status !== 'OPEN') {
      throw new NotFoundException();
    }
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.boardReport.updateMany({
        where: { post_id: report.post_id, status: 'OPEN' },
        data: { status: uphold ? 'UPHELD' : 'DISMISSED', resolved_by: subject.id, resolved_at: new Date() },
      });
      const post = await tx.post.findUnique({ where: { id: report.post_id } });
      if (post && !post.deleted_at) {
        if (uphold) {
          await tx.post.update({
            where: { id: post.id },
            data: { status: 'DELETED', deleted_at: new Date() },
          });
          if (post.status === 'PUBLISHED') {
            await tx.board.update({ where: { id: post.board_id }, data: { post_count: { decrement: 1 } } });
          }
        } else if (post.status === 'HIDDEN') {
          await tx.post.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
        }
      }
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id,
        action: uphold ? 'board.report.uphold' : 'board.report.dismiss',
        targetType: 'post', targetId: report.post_id, detail: { before: {}, after: {} },
      });
    });
    return { ok: true };
  }
}
