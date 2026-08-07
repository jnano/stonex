import { Injectable } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { AuditService } from '../audit/audit.service';

export interface RoleGrantInput {
  tenantId: string;
  userId: string;
  roleId: string;
  roleCode: string; // 감사 로그 가독성용
  /** 부여 주체. null = 시스템 행위(가입 시 자동 부여 등) */
  actorId: string | null;
  expiresAt?: Date | null;
  /** 감사 로그의 변경 전 상태 (호출자가 아는 값) */
  before?: Record<string, unknown>;
}

/**
 * 역할 부여/회수의 유일한 통로 (기획서 §4.6, INV-6).
 *
 * user_roles 를 직접 조작하는 코드는 G-2(Semgrep authz-bypass-role-tables)가 차단한다 —
 * 이 서비스만 예외로 허용되며, 여기서 **부여와 감사 기록이 항상 같은 트랜잭션으로 묶인다**.
 * 우위·부분집합 검사(§4.6)는 관리자 경로(WP-5)에서 이 서비스를 호출하기 전에 수행한다.
 * 시스템 행위(actorId=null, 가입 시 MEMBER 자동 부여)는 검사 대상이 아니지만 감사는 동일하게 남는다.
 */
@Injectable()
export class RoleGrantService {
  constructor(private readonly audit: AuditService) {}

  /** 역할 부여 + 감사 기록 (동일 트랜잭션). 기록 실패 시 부여도 롤백된다 */
  async grant(tx: Prisma.TransactionClient, input: RoleGrantInput): Promise<void> {
    await tx.userRole.upsert({
      where: { user_id_role_id: { user_id: input.userId, role_id: input.roleId } },
      update: {},
      create: {
        tenant_id: input.tenantId,
        user_id: input.userId,
        role_id: input.roleId,
        granted_by: input.actorId ?? undefined,
        expires_at: input.expiresAt ?? undefined,
      },
    });
    await this.audit.record(tx, {
      tenantId: input.tenantId,
      actorId: input.actorId,
      action: 'role.grant',
      targetType: 'user',
      targetId: input.userId,
      detail: { before: input.before ?? {}, after: { role: input.roleCode } },
    });
  }

  /** 역할 회수 + 감사 기록 (동일 트랜잭션) */
  async revoke(tx: Prisma.TransactionClient, input: Omit<RoleGrantInput, 'expiresAt'>): Promise<void> {
    await tx.userRole.deleteMany({ where: { user_id: input.userId, role_id: input.roleId } });
    await this.audit.record(tx, {
      tenantId: input.tenantId,
      actorId: input.actorId,
      action: 'role.revoke',
      targetType: 'user',
      targetId: input.userId,
      detail: { before: { role: input.roleCode }, after: {} },
    });
  }
}
