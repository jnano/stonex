import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedOnly, RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { DomainsService } from './domains.service';
import { DomainVerificationService, VerificationAttemptView } from './verification.service';
import { CreateDomainDto, UpdateDomainDto } from './domain.dto';
import { DomainSummary } from './domain.serializer';

/**
 * 도메인 API — 회원 경로 (기획서 §6.4 DOM-1~4·7).
 *
 * **컬렉션 규약**(§7.3): 목록은 `owned` scope 로 게이트할 수 없으므로 인증만을 게이트로 하고
 * 행 범위는 서비스가 강제한다. **라우트 분리**(§7.3): `.all` 관리자 경로는 `/admin/domains` 로
 * 분리한다 — 한 라우트에 두 코드를 OR 로 묶으면 DENY 제재가 다른 코드로 관통된다.
 */
@Controller('domains')
export class DomainsController {
  constructor(
    private readonly domains: DomainsService,
    private readonly verification: DomainVerificationService,
  ) {}

  /** DOM-2 등록 — `domain.create` 는 global(대상 리소스가 아직 없다) */
  @RequirePermission('domain.create')
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: CreateDomainDto): Promise<DomainSummary> {
    return this.domains.create(subjectOf(req), body.fqdn);
  }

  @AuthenticatedOnly()
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<{ items: DomainSummary[]; total: number }> {
    return this.domains.listVisible(subjectOf(req), Number(page ?? 1), Number(size ?? 20));
  }

  @RequirePermission('domain.read', { resource: { type: 'domain', param: 'id' } })
  @Get(':id')
  async detail(@Req() req: AuthedRequest, @Param('id') id: string): Promise<DomainSummary> {
    return this.domains.detail(id, subjectOf(req).id);
  }

  @RequirePermission('domain.read', { resource: { type: 'domain', param: 'id' } })
  @Get(':id/verification')
  async history(@Param('id') id: string): Promise<VerificationAttemptView[]> {
    return this.verification.history(id);
  }

  /**
   * DOM-3 소유권 검증 요청 — **잡을 적재하고 즉시 202 를 반환한다.**
   * DNS 조회를 여기서 하면 상위 리졸버 지연이 그대로 API 지연이 된다.
   */
  @RequirePermission('domain.verify', { resource: { type: 'domain', param: 'id' } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':id/verify')
  async verify(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.verification.request(subjectOf(req), id);
  }

  @RequirePermission('domain.update', { resource: { type: 'domain', param: 'id' } })
  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateDomainDto,
  ): Promise<DomainSummary> {
    return this.domains.update(subjectOf(req), id, body.fqdn);
  }

  @RequirePermission('domain.delete', { resource: { type: 'domain', param: 'id' } })
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.domains.softDelete(subjectOf(req), id);
    return { ok: true };
  }
}

/** 관리자 경로 — `.all` 권한 전용 (라우트 분리 규약, 작업지시서 WP-12-6) */
@Controller('admin/domains')
export class AdminDomainsController {
  constructor(
    private readonly domains: DomainsService,
    private readonly verification: DomainVerificationService,
  ) {}

  @RequirePermission('domain.read.all')
  @Get()
  async listAll(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<{ items: DomainSummary[]; total: number }> {
    return this.domains.listAll(subjectOf(req), Number(page ?? 1), Number(size ?? 20));
  }

  @RequirePermission('domain.read.all', { resource: { type: 'domain', param: 'id' } })
  @Get(':id')
  async detail(@Req() req: AuthedRequest, @Param('id') id: string): Promise<DomainSummary> {
    return this.domains.detail(id, subjectOf(req).id);
  }

  @RequirePermission('domain.update.all', { resource: { type: 'domain', param: 'id' } })
  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateDomainDto,
  ): Promise<DomainSummary> {
    return this.domains.update(subjectOf(req), id, body.fqdn);
  }

  @RequirePermission('domain.verify.all', { resource: { type: 'domain', param: 'id' } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':id/verify')
  async verify(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.verification.request(subjectOf(req), id);
  }

  @RequirePermission('domain.delete.all', { resource: { type: 'domain', param: 'id' } })
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.domains.softDelete(subjectOf(req), id);
    return { ok: true };
  }
}

function subjectOf(req: AuthedRequest): SubjectSnapshot {
  const subject = req.subject;
  if (!subject) throw new UnauthorizedException();
  return subject;
}
