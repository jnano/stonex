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
}

class UpdatePostDto {
  @IsOptional() @IsString() @Length(1, 300) title?: string;
  @IsOptional() @IsString() @Length(1, 100_000) bodyMd?: string;
  @IsOptional() @IsBoolean() publish?: boolean;
  @IsOptional() @IsUUID(undefined, { each: true }) attachmentFileIds?: string[];
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

  @AuthenticatedOnly()
  @Get(':id/posts')
  async listPosts(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<{ items: PostSummary[]; total: number }> {
    return this.posts.list(subjectOf(req), id, Number(page ?? 1), Number(size ?? 20));
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
  ) {}

  @RequirePermission('board.read', { resource: { type: 'post', param: 'id' } })
  @Get(':id')
  async detail(@Req() req: AuthedRequest, @Param('id') id: string): Promise<PostDetail> {
    return this.posts.detail(subjectOf(req), id);
  }

  @RequirePermission('post.update', { resource: { type: 'post', param: 'id' } })
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
}

/** `.all` 관리자 경로 — 라우트 분리(코어 §7.3, anyOf 금지) */
@Controller('admin')
export class BoardAdminController {
  constructor(
    private readonly posts: PostsService,
    private readonly comments: CommentsService,
  ) {}

  @RequirePermission('post.delete.all')
  @Delete('posts/:id')
  async removePost(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    const subject = subjectOf(req);
    await this.posts.loadForAdmin(subject, id);
    await this.posts.softDelete(subject, id, true);
    return { ok: true };
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
