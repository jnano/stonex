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
import { DelegationSummary, DomainDelegationsService } from './delegations.service';
import { DomainTransfersService, TransferSummary } from './transfers.service';
import {
  CreateDelegationDto,
  CreateDomainDto,
  ProposeTransferDto,
  UpdateDomainDto,
} from './domain.dto';
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
    private readonly delegations: DomainDelegationsService,
    private readonly transfers: DomainTransfersService,
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

  // ── DOM-5 운영 위임 ──
  // 게이트는 `domain.share`(owned) — 소유자만 도달한다. 관리자에게는 위임 **생성** 경로를 주지
  // 않는다(회수만 필요하다). 위임 대상 권한은 §4.4 화이트리스트가 강제한다.
  @RequirePermission('domain.share', { resource: { type: 'domain', param: 'id' } })
  @Post(':id/delegations')
  async createDelegation(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreateDelegationDto,
  ): Promise<DelegationSummary[]> {
    return this.delegations.create(subjectOf(req), id, {
      subjectId: body.subjectId,
      permissions: body.permissions,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  @RequirePermission('domain.share', { resource: { type: 'domain', param: 'id' } })
  @Get(':id/delegations')
  async listDelegations(@Req() req: AuthedRequest, @Param('id') id: string): Promise<DelegationSummary[]> {
    return this.delegations.list(subjectOf(req), id);
  }

  /**
   * 위임 회수 — 게이트는 `domain.read`(소유자·수임자 모두 통과 가능)로 두고,
   * "소유자 또는 생성자 또는 관리자" 관계 판정은 PolicyService 가 한다(§7.3).
   * 게이트를 `domain.share` 로 두면 생성자(비소유자)가 자기 위임을 회수하지 못한다.
   */
  @RequirePermission('domain.read', { resource: { type: 'domain', param: 'id' } })
  @Delete(':id/delegations/:grantId')
  async revokeDelegation(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ): Promise<{ ok: true }> {
    await this.delegations.revoke(subjectOf(req), id, grantId);
    return { ok: true };
  }

  // ── DOM-6 소유자 이전(발의·취소) ──
  @RequirePermission('domain.transfer', { resource: { type: 'domain', param: 'id' } })
  @Post(':id/transfers')
  async proposeTransfer(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ProposeTransferDto,
  ): Promise<TransferSummary> {
    return this.transfers.propose(subjectOf(req), id, body.toUserId);
  }

  @RequirePermission('domain.transfer', { resource: { type: 'domain', param: 'id' } })
  @Delete(':id/transfers/:transferId')
  async cancelTransfer(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('transferId') transferId: string,
  ): Promise<{ ok: true }> {
    await this.transfers.cancel(subjectOf(req), id, transferId);
    return { ok: true };
  }

  @RequirePermission('domain.delete', { resource: { type: 'domain', param: 'id' } })
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.domains.softDelete(subjectOf(req), id);
    return { ok: true };
  }
}

/**
 * 이전 발의 수락·조회 — **인증 게이트형**(기획서 v1.7 §7.3).
 *
 * 수령자는 대상 도메인에 대해 아무 권한도 갖고 있지 않으므로 `@RequirePermission` 으로는
 * 게이트할 수 없다. **평가기 0~4단계가 한 줄도 실행되지 않으며**, 검증은 전적으로
 * `PolicyService.canAcceptTransfer` 가 잠근 상태 위에서 재현한다.
 */
@Controller('transfers')
export class DomainTransfersController {
  constructor(private readonly transfers: DomainTransfersService) {}

  @AuthenticatedOnly()
  @Get()
  async listMine(@Req() req: AuthedRequest): Promise<TransferSummary[]> {
    return this.transfers.listMine(subjectOf(req));
  }

  @AuthenticatedOnly()
  @Post(':id/accept')
  async accept(@Req() req: AuthedRequest, @Param('id') id: string): Promise<TransferSummary> {
    return this.transfers.accept(subjectOf(req), id);
  }
}

/** 관리자 경로 — `.all` 권한 전용 (라우트 분리 규약, 작업지시서 WP-12-6) */
@Controller('admin/domains')
export class AdminDomainsController {
  constructor(
    private readonly domains: DomainsService,
    private readonly verification: DomainVerificationService,
    private readonly delegations: DomainDelegationsService,
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

  /**
   * 관리자 위임 회수 — `domain.share.all`(global).
   * 이 라우트가 없으면 정책 함수의 ADMIN 분기에 **도달할 경로가 없다**: 회원 경로의 게이트는
   * `domain.read`(owned) 라 타인 도메인에서는 Guard 를 통과하지 못하기 때문이다.
   * 소유자 계정이 정지됐을 때 유출된 위임을 끊는 유일한 통로다.
   */
  @RequirePermission('domain.share.all', { resource: { type: 'domain', param: 'id' } })
  @Delete(':id/delegations/:grantId')
  async revokeDelegation(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ): Promise<{ ok: true }> {
    await this.delegations.revoke(subjectOf(req), id, grantId);
    return { ok: true };
  }

  @RequirePermission('domain.share.all', { resource: { type: 'domain', param: 'id' } })
  @Get(':id/delegations')
  async listDelegations(@Req() req: AuthedRequest, @Param('id') id: string): Promise<DelegationSummary[]> {
    return this.delegations.list(subjectOf(req), id);
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
