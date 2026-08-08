import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { ResourceLoaderRegistry } from '../authorization/resource-loader';
import { SnapshotService } from '../authorization/snapshot.service';
import { DecisionCode, SubjectSnapshot } from '../authorization/types';

/**
 * 응답에 실을 수 있는 사유 — **평가기가 낸 구조화 코드를 그대로 쓴다**(WT-13).
 *
 * 평가기의 `Decision.reason` 은 자유 텍스트라 서버 로그 전용이다. 응답 스키마에 자유 텍스트가
 * 들어가면 이후 누가 그 문자열에 내부 정보를 덧붙여도 아무도 검출하지 못한다.
 */
export type SimulationReason = DecisionCode;

export interface SimulationResult {
  allow: boolean;
  /** 평가기 §4.7 의 단계 번호 (0~5) */
  step: number;
  reason: SimulationReason;
  subjectId: string;
  permission: string;
  resource: { type: string; id: string } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ADM-5 권한 시뮬레이터 (기획서 §6.5, §4.6-3).
 *
 * **평가기의 `can()` 을 그대로 호출한다.** 별도 판정 로직을 만들면 실제 API 응답과 어긋나고,
 * 그 어긋남은 "시뮬레이터가 된다고 했는데 실제로는 안 된다"는 형태로만 드러나 신뢰를 잃는다(§14.5-1).
 *
 * **우위 검사는 적용하지 않는다**(§4.6-3). 이 기능의 1차 용도가 "왜 이 사람을 관리할 수 없는가"의
 * 설명이므로, 제압 불가능한 대상을 못 보게 하면 존재 이유가 사라진다.
 */
@Injectable()
export class PermissionSimulatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly snapshots: SnapshotService,
    private readonly loaders: ResourceLoaderRegistry,
    private readonly audit: AuditService,
  ) {}

  async simulate(
    actor: SubjectSnapshot,
    input: { subjectId: string; permission: string; resourceType?: string; resourceId?: string },
  ): Promise<SimulationResult> {
    // 비UUID·미등록 타입은 500 이 아니라 404 로 정규화한다 — 응답 형상이 갈리면
    // 그 차이 자체가 존재 여부를 알려주는 오라클이 된다(§10.2)
    if (!UUID_RE.test(input.subjectId)) throw new NotFoundException();
    if (!input.permission) throw new BadRequestException('permission 이 필요합니다.');

    const target = await this.snapshots.rebuildFromDb(input.subjectId);
    if (!target || target.tenantId !== actor.tenantId) throw new NotFoundException();

    const resource = input.resourceType && input.resourceId
      ? await this.loaders.load(input.resourceType, input.resourceId)
      : undefined;

    const decision = await this.authz.can(target, input.permission, resource);

    // **전건 감사 기록**(§14.4 — 감시자도 감사 대상). 무엇을 조회했는지 남기지 않으면
    // 시뮬레이터가 권한 지도를 훑는 도구로 쓰여도 사후에 알 수 없다.
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorId: actor.id,
        action: 'admin.simulate',
        targetType: 'user',
        targetId: input.subjectId,
        detail: {
          before: {},
          after: {
            permission: input.permission,
            resourceType: input.resourceType ?? null,
            resourceId: input.resourceId ?? null,
            allow: decision.allow,
            step: decision.step,
          },
        },
      });
    });

    return {
      allow: decision.allow,
      step: decision.step,
      reason: decision.code,
      subjectId: input.subjectId,
      permission: input.permission,
      resource: resource ? { type: resource.type, id: resource.id } : null,
    };
  }
}
