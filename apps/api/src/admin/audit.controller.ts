import { Body, Controller, Get, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { AuditEntryView, AuditQueryService } from './audit-query.service';
import { PermissionSimulatorService, SimulationResult } from './simulator.service';

export class SimulateDto {
  @IsString()
  @IsNotEmpty()
  subjectId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  permission!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  resourceType?: string;

  @IsOptional()
  @IsString()
  resourceId?: string;
}

/**
 * ADM-4 감사 로그 조회 · ADM-5 권한 시뮬레이터 (기획서 §6.5).
 *
 * 두 기능의 권한이 다르다: 조회는 `admin.audit.read`, 시뮬레이터는 `admin.role.read`.
 * 시뮬레이터를 감사 권한에 묶지 않는 이유는 §4.6-3이 그 1차 용도를 "왜 이 사람을 관리할 수
 * 없는가"의 설명으로 규정하기 때문이다 — 역할을 다루는 사람이 곧 사용자다.
 */
@Controller('admin')
export class AdminAuditController {
  constructor(
    private readonly audits: AuditQueryService,
    private readonly simulator: PermissionSimulatorService,
  ) {}

  /**
   * ADM-4. **기간 필터가 필수**다 — 파티션 테이블에서 기간 없는 조회는 전 구간 스캔이 되고,
   * 그 사이 감사 INSERT 가 밀리면 INV-6 에 의해 모든 권한 변경이 롤백된다.
   */
  @RequirePermission('admin.audit.read')
  @Get('audit-logs')
  async search(
    @Req() req: AuthedRequest,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<{ items: AuditEntryView[]; total: number }> {
    return this.audits.search(subjectOf(req).tenantId, {
      from: new Date(from),
      to: new Date(to),
      actorId, action, targetType, targetId,
      page: Number(page ?? 1),
      size: Number(size ?? 50),
    });
  }

  /** ADM-5. 우위 검사를 적용하지 않는다(§4.6-3) — 적용하면 이 기능의 존재 이유가 사라진다 */
  @RequirePermission('admin.role.read')
  @Post('simulate')
  async simulate(@Req() req: AuthedRequest, @Body() body: SimulateDto): Promise<SimulationResult> {
    return this.simulator.simulate(subjectOf(req), body);
  }
}

function subjectOf(req: AuthedRequest): SubjectSnapshot {
  const subject = req.subject;
  if (!subject) throw new UnauthorizedException();
  return subject;
}
