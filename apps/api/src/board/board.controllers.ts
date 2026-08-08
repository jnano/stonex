import {
  Body, Controller, Delete, Get, Param, Patch, Post as HttpPost, Query, Req, UnauthorizedException,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { AuthenticatedOnly, RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { BoardSummary, BoardsService } from './boards.service';
import { AttachmentResult, BoardAttachmentService } from './board-attachment.service';
import { UploadTicket } from '../storage/upload-session.service';
import { PostDetail, PostSummary, PostsService } from './posts.service';
import { CommentView, CommentsService } from './comments.service';
import { BoardReactionsService, ReactionSummary } from './capabilities.service';
import { BoardSearchService } from './search.service';
import { BoardReportsService, ReportView } from './reports.service';
import { BoardPatrolService, BriResult } from './board-patrol.service';
import { PrismaService } from '../prisma/prisma.service';
import { BoardNotificationService, NotificationView } from './notification.service';

/**
 * 게시판 API (WP-B1 — 스펙 §10.1).
 *
 * 게이트 규약 그대로:
 *  - 컬렉션은 인증 게이트 + 정책 행범위 (owned Permission 으로 게이트하지 않는다 — RT-22)
 *  - 단건은 can() + canAccessBoard 2단 (평면 1 은 Guard, 평면 2 는 서비스)
 *  - `.all` 관리자 경로는 /admin/* 분리 (anyOf 금지 — 코어 §7.3)
 *  - 비회원 접근 없음 — 전 라우트 인증 필수 (DEC-4: PUBLIC 게시판도 로그인해야 읽기)
 */

class CreateBoardDto {
  @IsString() @Length(3, 64) slug!: string;
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(1, 32) boardType?: string;
  @IsOptional() @IsIn(['PUBLIC', 'RESTRICTED', 'PRIVATE']) visibility?: string;
}

class UpdateBoardDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsIn(['PUBLIC', 'RESTRICTED', 'PRIVATE']) visibility?: string;
  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: string;
}

class AddMemberDto {
  @IsUUID() userId!: string;
  @IsOptional() @IsIn(['OWNER', 'MODERATOR', 'MEMBER', 'READER']) boardRole?: string;
}

class CreatePostDto {
  @IsString() @Length(1, 300) title!: string;
  @IsString() @Length(1, 100_000) bodyMd!: string;
  @IsOptional() @IsBoolean() draft?: boolean;
  @IsOptional() @IsUUID(undefined, { each: true }) attachmentFileIds?: string[];
  @IsOptional() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsBoolean() secret?: boolean;
  @IsOptional() @IsUUID(undefined, { each: true }) secretReaderIds?: string[];
}

class UpdatePostDto {
  @IsOptional() @IsString() @Length(1, 300) title?: string;
  @IsOptional() @IsString() @Length(1, 100_000) bodyMd?: string;
  @IsOptional() @IsBoolean() publish?: boolean;
  @IsOptional() @IsUUID(undefined, { each: true }) attachmentFileIds?: string[];
  @IsOptional() @IsString({ each: true }) tags?: string[];
}

class ReactionDto {
  @IsString() @Length(1, 24) kind!: string;
}

class ReportDto {
  @IsString() @Length(1, 300) reason!: string;
}

class ModerateDto {
  @IsOptional() @IsBoolean() pin?: boolean;
  @IsOptional() @IsBoolean() hide?: boolean;
  @IsOptional() @IsUUID() moveToBoardId?: string;
}

class CoAuthorsDto {
  @IsUUID(undefined, { each: true }) userIds!: string[];
}

class CapabilityDto {
  @IsString() @Length(1, 48) key!: string;
  @IsBoolean() enabled!: boolean;
}

class IssueUploadDto {
  @IsString() @Length(1, 127) contentType!: string;
  @IsInt() @Min(1) contentLength!: number;
}

class CompleteUploadDto {
  @IsUUID() uploadId!: string;
  @IsString() @Length(1, 64) checksum!: string;
  @IsString() @Length(1, 255) name!: string;
}

class CreateCommentDto {
  @IsString() @Length(1, 10_000) bodyMd!: string;
  @IsOptional() @IsUUID() parentId?: string;
}

class UpdateCommentDto {
  @IsString() @Length(1, 10_000) bodyMd!: string;
}

function subjectOf(req: AuthedRequest): SubjectSnapshot {
  const subject = req.subject;
  if (!subject) throw new UnauthorizedException();
  return subject;
}

@Controller('boards')
export class BoardsController {
  constructor(
    private readonly boards: BoardsService,
    private readonly posts: PostsService,
    private readonly attachments: BoardAttachmentService,
    private readonly search: BoardSearchService,
  ) {}

  @AuthenticatedOnly()
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<{ items: BoardSummary[]; total: number }> {
    return this.boards.listVisible(subjectOf(req), Number(page ?? 1), Number(size ?? 20));
  }

  @RequirePermission('board.read', { resource: { type: 'board', param: 'id' } })
  @Get(':id')
  async detail(@Req() req: AuthedRequest, @Param('id') id: string): Promise<BoardSummary> {
    return this.boards.detail(subjectOf(req), id);
  }

  @RequirePermission('board.manage')
  @HttpPost()
  async create(@Req() req: AuthedRequest, @Body() body: CreateBoardDto): Promise<BoardSummary> {
    return this.boards.create(subjectOf(req), body);
  }

  @RequirePermission('board.manage', { resource: { type: 'board', param: 'id' } })
  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateBoardDto,
  ): Promise<BoardSummary> {
    return this.boards.update(subjectOf(req), id, body);
  }

  @RequirePermission('board.manage', { resource: { type: 'board', param: 'id' } })
  @HttpPost(':id/members')
  async addMember(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: AddMemberDto,
  ): Promise<{ ok: true }> {
    await this.boards.addMember(subjectOf(req), id, body);
    return { ok: true };
  }

  @RequirePermission('board.manage', { resource: { type: 'board', param: 'id' } })
  @Delete(':id/members/:userId')
  async removeMember(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<{ ok: true }> {
    await this.boards.removeMember(subjectOf(req), id, userId);
    return { ok: true };
  }

  /** 게시판 내 검색 (§8.1) — 목록과 같은 게이트·행 조건. 비가시 게시판은 404(R-B8) */
  @AuthenticatedOnly()
  @Get(':id/search')
  async searchPosts(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query('q') q?: string,
  ): Promise<PostSummary[]> {
    return this.search.search(subjectOf(req), id, q ?? '');
  }

  @RequirePermission('board.manage', { resource: { type: 'board', param: 'id' } })
  @Get(':id/capabilities')
  async listCapabilities(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<Array<{ key: string; enabled: boolean }>> {
    return this.boards.listCapabilities(subjectOf(req), id);
  }

  @RequirePermission('board.manage', { resource: { type: 'board', param: 'id' } })
  @Patch(':id/capabilities')
  async setCapability(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CapabilityDto,
  ): Promise<{ ok: true }> {
    await this.boards.setCapability(subjectOf(req), id, body.key, body.enabled);
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Get(':id/posts')
  async listPosts(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('size') size?: string,
  ): Promise<{ items: PostSummary[]; nextCursor: string | null }> {
    return this.posts.list(subjectOf(req), id, { cursor, size: Number(size ?? 20) });
  }

  /** 드래그앤드랍 첨부 세션 (§7.2) — 쓰기 가능한 게시판에서만. 응답에 storage_key 없음 */
  @RequirePermission('file.upload', { resource: { type: 'board', param: 'id' } })
  @HttpPost(':id/uploads')
  async issueUpload(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: IssueUploadDto,
  ): Promise<UploadTicket> {
    return this.attachments.issueUpload(subjectOf(req), id, body);
  }

  /** 업로드 완료 콜백 — 입력은 upload_id 뿐(R-B7). 이미지는 재인코딩을 통과해야 첨부다 */
  @RequirePermission('file.upload')
  @HttpPost('attachments/complete')
  async completeUpload(
    @Req() req: AuthedRequest,
    @Body() body: CompleteUploadDto,
  ): Promise<AttachmentResult> {
    return this.attachments.completeUpload(subjectOf(req), body);
  }

  @RequirePermission('board.write', { resource: { type: 'board', param: 'id' } })
  @HttpPost(':id/posts')
  async createPost(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreatePostDto,
  ): Promise<PostDetail> {
    return this.posts.create(subjectOf(req), id, body);
  }
}

@Controller('posts')
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly comments: CommentsService,
    private readonly reactions: BoardReactionsService,
    private readonly reports: BoardReportsService,
  ) {}

  @RequirePermission('board.read', { resource: { type: 'post', param: 'id' } })
  @Get(':id')
  async detail(@Req() req: AuthedRequest, @Param('id') id: string): Promise<PostDetail> {
    return this.posts.detail(subjectOf(req), id);
  }

  /**
   * 수정 — 인증 게이트형(§6.5 co-author). owned Guard 로는 공동작성자를 표현할 수 없어,
   * 판정은 서비스의 canEditPost(작성자 ∨ 공동작성자 ∨ 운영자)가 한다. 코어 FILE-5 패턴.
   */
  @AuthenticatedOnly()
  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdatePostDto,
  ): Promise<PostDetail> {
    return this.posts.update(subjectOf(req), id, body);
  }

  @RequirePermission('post.delete', { resource: { type: 'post', param: 'id' } })
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.posts.softDelete(subjectOf(req), id);
    return { ok: true };
  }

  /**
   * 운영 행위 (§10.1 moderate/*) — 고정·이동·숨김/해제.
   * 게이트는 `board.moderate`(owned scope — 해당 글의 게시판 Grant 로 판정).
   * 삭제가 아니라 **되돌릴 수 있는 표시 변경**이며 전부 감사에 남는다.
   */
  @RequirePermission('board.moderate', { resource: { type: 'post', param: 'id' } })
  @HttpPost(':id/moderate')
  async moderate(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ModerateDto,
  ): Promise<PostSummary> {
    return this.posts.moderate(subjectOf(req), id, body);
  }

  /** 공동작성자 지정 (§6.5) — 원작성자만. owner_id 는 불변(R-B12) */
  @AuthenticatedOnly()
  @HttpPost(':id/authors')
  async setCoAuthors(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CoAuthorsDto,
  ): Promise<{ ok: true }> {
    await this.posts.setCoAuthors(subjectOf(req), id, body.userIds);
    return { ok: true };
  }

  /** 신고 (기능모듈 report — R-B15). 자동 발동 상한은 임시 숨김 + 운영 대기 */
  @RequirePermission('board.read', { resource: { type: 'post', param: 'id' } })
  @HttpPost(':id/report')
  async report(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ReportDto,
  ): Promise<{ ok: true }> {
    return this.reports.report(subjectOf(req), id, body.reason);
  }

  /** 반응 토글 (기능모듈 reaction — §6.4). 꺼진 게시판이면 404 */
  @RequirePermission('board.read', { resource: { type: 'post', param: 'id' } })
  @HttpPost(':id/reactions')
  async toggleReaction(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ReactionDto,
  ): Promise<{ added: boolean }> {
    const subject = subjectOf(req);
    const post = await this.posts.loadForAdmin(subject, id); // 존재·테넌트 확인 재사용
    return this.reactions.toggle(subject, post, body.kind);
  }

  @RequirePermission('board.read', { resource: { type: 'post', param: 'id' } })
  @Get(':id/reactions')
  async listReactions(@Req() req: AuthedRequest, @Param('id') id: string): Promise<ReactionSummary[]> {
    return this.reactions.summary(id, subjectOf(req).id);
  }

  @RequirePermission('board.read', { resource: { type: 'post', param: 'id' } })
  @Get(':id/comments')
  async listComments(@Req() req: AuthedRequest, @Param('id') id: string): Promise<CommentView[]> {
    return this.comments.list(subjectOf(req), id);
  }

  @RequirePermission('board.comment', { resource: { type: 'post', param: 'id' } })
  @HttpPost(':id/comments')
  async createComment(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreateCommentDto,
  ): Promise<CommentView> {
    return this.comments.create(subjectOf(req), id, body);
  }
}

@Controller('comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @RequirePermission('comment.update', { resource: { type: 'comment', param: 'id' } })
  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateCommentDto,
  ): Promise<CommentView> {
    return this.comments.update(subjectOf(req), id, body.bodyMd);
  }

  @RequirePermission('comment.delete', { resource: { type: 'comment', param: 'id' } })
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.comments.softDelete(subjectOf(req), id);
    return { ok: true };
  }

  /** 댓글 반응 토글 (WP-B6) — 글 반응과 같은 기능모듈(reaction) 토글을 따른다 */
  @RequirePermission('board.read', { resource: { type: 'comment', param: 'id' } })
  @HttpPost(':id/reactions')
  async toggleReaction(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ReactionDto,
  ): Promise<{ added: boolean }> {
    return this.comments.toggleReaction(subjectOf(req), id, body.kind);
  }
}

/** 사용자 차단 (§6.5 user-block — **표시 필터**이지 보안 경계가 아니다. 본인 한정) */
@Controller('me/blocks')
export class UserBlocksController {
  constructor(private readonly prisma: PrismaService) {}

  @AuthenticatedOnly()
  @HttpPost(':userId')
  async toggle(@Req() req: AuthedRequest, @Param('userId') userId: string): Promise<{ blocked: boolean }> {
    const subject = subjectOf(req);
    if (userId === subject.id) throw new UnauthorizedException();
    const key = { blocker_id: subject.id, blocked_id: userId };
    const existing = await this.prisma.userBlock.findUnique({ where: { blocker_id_blocked_id: key } });
    if (existing) {
      await this.prisma.userBlock.delete({ where: { blocker_id_blocked_id: key } });
      return { blocked: false };
    }
    await this.prisma.userBlock.create({ data: key });
    return { blocked: true };
  }
}

/** 알림 (기반 기능모듈 — 본인 한정, 권한 검사 대상 아님) */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: BoardNotificationService) {}

  @AuthenticatedOnly()
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('unread') unread?: string,
  ): Promise<NotificationView[]> {
    return this.notifications.listMine(subjectOf(req), unread === '1');
  }

  @AuthenticatedOnly()
  @HttpPost(':id/read')
  async markRead(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.notifications.markRead(subjectOf(req), id);
    return { ok: true };
  }
}

/** `.all` 관리자 경로 — 라우트 분리(코어 §7.3, anyOf 금지) */
@Controller('admin')
export class BoardAdminController {
  constructor(
    private readonly posts: PostsService,
    private readonly comments: CommentsService,
    private readonly reports: BoardReportsService,
    private readonly patrol: BoardPatrolService,
  ) {}

  @RequirePermission('post.delete.all')
  @Delete('posts/:id')
  async removePost(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    const subject = subjectOf(req);
    await this.posts.loadForAdmin(subject, id);
    await this.posts.softDelete(subject, id, true);
    return { ok: true };
  }

  /**
   * 전체 게시판 운영 행위 — `board.moderate.all` 경로 분리(§7.3 anyOf 금지).
   * 게시판 단위 위임(board.moderate Grant)은 `/posts/:id/moderate` 를 쓴다.
   */
  @RequirePermission('board.moderate.all')
  @HttpPost('board/posts/:id/moderate')
  async moderateAll(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ModerateDto,
  ): Promise<PostSummary> {
    const subject = subjectOf(req);
    await this.posts.loadForAdmin(subject, id); // 존재·테넌트 확인
    return this.posts.moderate(subject, id, body);
  }

  /** 숨김 글 상세 — 일반 상세는 HIDDEN 을 404 로 가리므로 운영 확인용 경로를 분리한다 */
  @RequirePermission('board.moderate.all')
  @Get('board/posts/:id')
  async postForModerator(@Req() req: AuthedRequest, @Param('id') id: string): Promise<PostDetail> {
    return this.posts.detailForModerator(subjectOf(req), id);
  }

  /** 신고 목록 (운영) */
  @RequirePermission('board.moderate.all')
  @Get('board/reports')
  async listReports(@Req() req: AuthedRequest): Promise<ReportView[]> {
    return this.reports.listOpen(subjectOf(req));
  }

  /** 신고 결정 — 삭제(uphold)·기각(dismiss)은 운영자의 명시적 행위이며 감사에 남는다(R-B15) */
  @RequirePermission('board.moderate.all')
  @HttpPost('board/reports/:id/resolve')
  async resolveReport(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { uphold?: boolean },
  ): Promise<{ ok: true }> {
    return this.reports.resolve(subjectOf(req), id, body.uphold === true);
  }

  /** BRI 순찰 상태·수동 실행 (§12) */
  @RequirePermission('governance.read')
  @Get('board/patrol')
  async patrolStatus(): Promise<BriResult[]> {
    return this.patrol.lastResults.length > 0 ? this.patrol.lastResults : this.patrol.patrol();
  }

  @RequirePermission('comment.delete.all')
  @Delete('comments/:id')
  async removeComment(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    const subject = subjectOf(req);
    await this.comments.loadForAdmin(subject, id);
    await this.comments.softDelete(subject, id, true);
    return { ok: true };
  }
}
