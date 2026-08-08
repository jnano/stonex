import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { ActionView, GovernanceStatusService, PatrolStatusView } from './governance.service';
import { FreezeSummary, GovernanceFreezeService } from './freeze.service';
import { AnomalyDetectionService, AnomalySignal } from './anomaly.service';

export class ReleaseFreezeDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * 거버넌스 콘솔 API (작업지시서 WP-14-5-1, RT-20).
 *
 * 조회는 `governance.read`, 동결 해제는 `governance.freeze.manage`(SUPER_ADMIN 전용).
 * 두 권한을 나눈 이유는 §14.4의 승인 규정 때문이다 — **상태를 보는 것과 제재를 푸는 것은
 * 다른 권한이어야** 승인이 형식적 절차로 전락하지 않는다.
 */
@Controller('admin/governance')
export class GovernanceController {
  constructor(
    private readonly status: GovernanceStatusService,
    private readonly freezes: GovernanceFreezeService,
    private readonly anomalies: AnomalyDetectionService,
  ) {}

  /** 순찰 상태 — 가동 여부·최근 실행·RI별 최신 판정. '검사 실패'는 '이상 없음'과 구분된다 */
  @RequirePermission('governance.read')
  @Get('status')
  async patrolStatus(): Promise<PatrolStatusView> {
    return this.status.status();
  }

  /** L-1 조치 이력 — 무엇을·왜·언제·회수 전 행 내용(화이트리스트) */
  @RequirePermission('governance.read')
  @Get('actions')
  async actions(@Query('limit') limit?: string): Promise<ActionView[]> {
    return this.status.actions(Number(limit ?? 50));
  }

  @RequirePermission('governance.read')
  @Get('freezes')
  async listFreezes(
    @Req() req: AuthedRequest,
    @Query('includeReleased') includeReleased?: string,
  ): Promise<FreezeSummary[]> {
    return this.freezes.list(subjectOf(req).tenantId, includeReleased === 'true');
  }

  /** 이상 탐지 피드 — 자동 동결은 하지 않는다. 사람이 보고 판단하는 화면이다 */
  @RequirePermission('governance.read')
  @Get('anomalies')
  async anomalyFeed(@Query('hours') hours?: string): Promise<AnomalySignal[]> {
    return this.anomalies.detect(Number(hours ?? 24));
  }

  /**
   * 동결 해제 승인 — `governance.freeze.manage`.
   * **피동결자 본인은 거부**되고, 승인 가능한 활성 SUPER_ADMIN 이 0명이면 break-glass 로 안내한다.
   * 두 판정 모두 서비스가 수행한다(§7.3 관계형 2차 인가).
   */
  @RequirePermission('governance.freeze.manage')
  @Post('freezes/:id/release')
  async release(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ReleaseFreezeDto,
  ): Promise<FreezeSummary> {
    return this.freezes.release(subjectOf(req), id, body.note);
  }
}

function subjectOf(req: AuthedRequest): SubjectSnapshot {
  const subject = req.subject;
  if (!subject) throw new UnauthorizedException();
  return subject;
}
