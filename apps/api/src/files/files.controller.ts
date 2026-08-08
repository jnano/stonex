import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedOnly, RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { FilesService } from './files.service';
import { CompleteUploadDto, CreateShareDto, CreateUploadUrlDto, UpdateFileDto } from './file.dto';
import { SharesService, ShareSummary } from './shares.service';
import { FileSummary } from './file.serializer';

/**
 * 파일 API — 회원 경로 (기획서 §6.3 FILE-1·2·6).
 *
 * **컬렉션 규약**(§7.3): 목록은 `owned` scope 권한으로 게이트할 수 없다(리소스가 없어 평가기
 * 3단계를 통과하지 못한다). 인증만을 게이트로 하고 행 범위는 서비스가 강제하며, 그 쿼리 조건이
 * 평가기 0~4단계와 등가임을 표 기반 테스트로 고정한다.
 * **라우트 분리**(§7.3): `.all` 관리자 경로는 `/admin/files` 로 분리한다 — 한 라우트에 코드 2개를
 * OR 로 묶으면(anyOf) DENY 제재가 다른 코드로 관통된다.
 */
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly shares: SharesService,
  ) {}

  @RequirePermission('file.upload')
  @Post('upload-url')
  async createUploadUrl(@Req() req: AuthedRequest, @Body() body: CreateUploadUrlDto) {
    return this.files.createUploadUrl(subjectOf(req), body);
  }

  /** 완료 콜백 — 불투명 uploadId 만 받는다. storage_key 는 클라이언트가 알지 못한다(§10.2) */
  @RequirePermission('file.upload')
  @Post('complete')
  async completeUpload(
    @Req() req: AuthedRequest,
    @Body() body: CompleteUploadDto & { name?: string },
  ): Promise<FileSummary> {
    return this.files.completeUpload(subjectOf(req), {
      uploadId: body.uploadId,
      checksum: body.checksum,
      name: body.name ?? '이름 없음',
    });
  }

  @AuthenticatedOnly()
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<{ items: FileSummary[]; total: number }> {
    return this.files.listVisible(subjectOf(req), Number(page ?? 1), Number(size ?? 20));
  }

  @RequirePermission('file.read', { resource: { type: 'file', param: 'id' } })
  @Get(':id')
  async detail(@Req() req: AuthedRequest, @Param('id') id: string): Promise<FileSummary> {
    return this.files.detail(id, subjectOf(req).id);
  }

  @RequirePermission('file.read', { resource: { type: 'file', param: 'id' } })
  @Get(':id/download-url')
  async downloadUrl(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.files.createDownloadUrl(subjectOf(req), id);
  }

  @RequirePermission('file.update', { resource: { type: 'file', param: 'id' } })
  @Patch(':id')
  async rename(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateFileDto,
  ): Promise<FileSummary> {
    return this.files.rename(subjectOf(req), id, body.name);
  }

  // ── FILE-3~5 공유 ──
  // 게이트는 `file.share`(owned) — 소유자만 통과한다. 관리자 경로(`file.share.all`)는
  // owned scope 라 Guard 를 통과할 수 없으므로 별도 라우트로 분리한다(§7.3 라우트 분리).
  @RequirePermission('file.share', { resource: { type: 'file', param: 'id' } })
  @Post(':id/shares')
  async createShare(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreateShareDto,
  ): Promise<ShareSummary[]> {
    return this.shares.create(subjectOf(req), id, {
      subjectId: body.subjectId,
      permissions: body.permissions,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  @RequirePermission('file.share', { resource: { type: 'file', param: 'id' } })
  @Get(':id/shares')
  async listShares(@Req() req: AuthedRequest, @Param('id') id: string): Promise<ShareSummary[]> {
    return this.shares.list(subjectOf(req), id);
  }

  /**
   * 공유 회수 — 게이트는 `file.read`(소유자·수령자 모두 통과 가능)로 두고,
   * "소유자 또는 생성자 또는 관리자" 관계 판정은 PolicyService 가 한다(§7.3 관계형 2차 인가).
   * 게이트를 `file.share` 로 두면 생성자(비소유자)가 자기 공유를 회수하지 못한다.
   */
  @RequirePermission('file.read', { resource: { type: 'file', param: 'id' } })
  @Delete(':id/shares/:grantId')
  async revokeShare(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ): Promise<{ ok: true }> {
    await this.shares.revoke(subjectOf(req), id, grantId);
    return { ok: true };
  }

  @RequirePermission('file.delete', { resource: { type: 'file', param: 'id' } })
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.files.softDelete(subjectOf(req), id);
    return { ok: true };
  }
}

/** 관리자 경로 — `.all` 권한 전용 (FILE-7, 라우트 분리 규약) */
@Controller('admin/files')
export class AdminFilesController {
  constructor(
    private readonly files: FilesService,
    private readonly shares: SharesService,
  ) {}

  @RequirePermission('file.read.all')
  @Get()
  async listAll(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<{ items: FileSummary[]; total: number }> {
    return this.files.listAll(subjectOf(req), Number(page ?? 1), Number(size ?? 20));
  }

  @RequirePermission('file.read.all', { resource: { type: 'file', param: 'id' } })
  @Get(':id')
  async detail(@Req() req: AuthedRequest, @Param('id') id: string): Promise<FileSummary> {
    return this.files.detail(id, subjectOf(req).id);
  }

  @RequirePermission('file.delete.all', { resource: { type: 'file', param: 'id' } })
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.files.softDelete(subjectOf(req), id);
    return { ok: true };
  }

  /** 관리자 공유 생성 — 부여 가능 권한은 `file.read` 뿐이다(§4.4, 서비스가 강제) */
  @RequirePermission('file.share.all', { resource: { type: 'file', param: 'id' } })
  @Post(':id/shares')
  async createShare(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreateShareDto,
  ): Promise<ShareSummary[]> {
    return this.shares.create(subjectOf(req), id, {
      subjectId: body.subjectId,
      permissions: body.permissions,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }
}

function subjectOf(req: AuthedRequest): SubjectSnapshot {
  const subject = req.subject;
  if (!subject) throw new UnauthorizedException();
  return subject;
}
