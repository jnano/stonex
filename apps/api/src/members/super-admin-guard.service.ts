import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@stonex/db';

const SUPER_ADMIN = 'SUPER_ADMIN';

/**
 * 최고관리자 보존 불변식 (기획서 §10.1, RI-1: "활성 SUPER_ADMIN ≥ 1").
 *
 * 회수·정지·삭제의 **모든 경로**에서 사전 검사한다. 검사와 변경은 반드시 같은 트랜잭션이며,
 * 대상 행을 FOR UPDATE 로 잠근 뒤 세어야 한다 — 잠금 없이 세면 두 관리자를 동시에 강등하는
 * 요청이 각각 "나 말고 1명 남는다"를 읽고 둘 다 통과해 시스템이 잠긴다(경쟁 조건).
 *
 * 사용 규약: 변경 **전에** ensureRemains() 를 호출하고, 같은 트랜잭션에서 변경을 수행한다.
 */
@Injectable()
export class SuperAdminGuardService {
  /**
   * targetUserId 가 SUPER_ADMIN 자격을 잃는다고 가정했을 때 활성 SUPER_ADMIN 이 1명 이상 남는지 검사.
   * 남지 않으면 ConflictException 으로 차단한다.
   *
   * 활성 = users.status='ACTIVE' AND (user_roles.expires_at IS NULL OR > now())
   * (SUPER_ADMIN 은 expires_at 지정이 금지되어 있으나(§4.5) 방어적으로 조건에 포함한다)
   */
  async ensureRemains(
    tx: Prisma.TransactionClient,
    targetUserId: string,
    tenantId: string,
  ): Promise<void> {
    // 불변식은 **테넌트 단위**로 성립한다. 테넌트를 구분하지 않고 세면 다른 테넌트의
    // 최고관리자가 남아 있다는 이유로 이 테넌트를 잠그는 강등이 통과한다(§9.2 대비).
    const isSuperAdmin = await tx.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ${targetUserId}::uuid
        AND r.code = ${SUPER_ADMIN}
        AND r.tenant_id = ${tenantId}::uuid
      LIMIT 1`;
    if (isSuperAdmin.length === 0) return;

    // 활성 SUPER_ADMIN 보유자 행 전체를 잠근 뒤 센다.
    // FOR UPDATE 로 동시 강등 요청을 직렬화하여 "둘 다 통과" 를 원천 차단한다.
    const holders = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT ur.user_id
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN users u ON u.id = ur.user_id
      WHERE r.code = ${SUPER_ADMIN}
        AND r.tenant_id = ${tenantId}::uuid
        AND u.status = 'ACTIVE'
        AND (ur.expires_at IS NULL OR ur.expires_at > now())
      FOR UPDATE OF ur, u`;

    const remaining = holders.filter((h) => h.user_id !== targetUserId).length;
    if (remaining < 1) {
      throw new ConflictException(
        '마지막 활성 최고관리자입니다. 다른 최고관리자를 먼저 지정해야 합니다.',
      );
    }
  }
}
