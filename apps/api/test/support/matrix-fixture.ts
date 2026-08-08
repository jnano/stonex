/**
 * 권한 매트릭스·공격 시나리오 공용 픽스처 (WP-8).
 * 시드 정의(db/seeds/permissions.ts)를 그대로 사용해 실제 역할 구성을 재현한다 —
 * 테스트 전용 역할을 만들면 매트릭스가 운영과 달라져 G-1 의 의미가 사라진다.
 */
import { PrismaClient } from '@stonex/db';
import { PERMISSIONS, ROLES, expandWildcards } from '../../../../db/seeds/permissions';
import { TokenService } from '../../src/auth/token.service';
import { uid } from './test-app';

/** 매트릭스의 행: 비인증 + 역할 5종 (RT-5 — 6행) */
export const MATRIX_ROWS = ['anonymous', ...ROLES.map((r) => r.code)] as const;
export type MatrixRow = (typeof MATRIX_ROWS)[number];

export interface RowActor {
  row: MatrixRow;
  userId: string | null;
  authorization: string | null;
}

/** 시드와 동일한 Permission·역할을 테스트 테넌트에 구성한다 */
export async function seedRolesForTenant(prisma: PrismaClient, tenantId: string): Promise<Record<string, string>> {
  await prisma.tenant.upsert({
    where: { id: tenantId }, update: {}, create: { id: tenantId, name: `t-${uid()}` },
  });
  const permIds: Record<string, string> = {};
  for (const p of PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { code: p.code },
      update: { scope: p.scope, module: p.module },
      create: { code: p.code, description: p.description, scope: p.scope, module: p.module },
    });
    permIds[p.code] = perm.id;
  }
  const roleIds: Record<string, string> = {};
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { tenant_id_code: { tenant_id: tenantId, code: r.code } },
      update: { requires_2fa: r.requires2fa, is_system: r.isSystem },
      create: {
        tenant_id: tenantId, code: r.code, name: r.name,
        display_order: r.displayOrder, requires_2fa: r.requires2fa, is_system: r.isSystem,
      },
    });
    roleIds[r.code] = role.id;
    for (const code of expandWildcards(r.permissions)) {
      await prisma.rolePermission.upsert({
        where: { role_id_permission_id: { role_id: role.id, permission_id: permIds[code] } },
        update: {},
        create: { tenant_id: tenantId, role_id: role.id, permission_id: permIds[code] },
      });
    }
  }
  return roleIds;
}

/** 역할별 사용자 + Access Token 생성. TOTP 는 등록 완료 상태로 둬 온보딩 게이트를 통과시킨다 */
export async function createActorForRole(
  prisma: PrismaClient,
  tokens: TokenService,
  tenantId: string,
  roleCode: string,
  roleIds: Record<string, string>,
): Promise<RowActor> {
  const user = await prisma.user.create({
    data: {
      tenant_id: tenantId, email: `${roleCode.toLowerCase()}-${uid()}@t.local`,
      password_hash: 'x', name: roleCode, status: 'ACTIVE',
      totp_secret: 'SEEDED', totp_enrollment_required: false, must_change_password: false,
    },
  });
  await prisma.userRole.create({
    data: { tenant_id: tenantId, user_id: user.id, role_id: roleIds[roleCode] },
  });
  const token = await tokens.signAccess({ sub: user.id, tenant: tenantId, pv: user.perm_version });
  return { row: roleCode as MatrixRow, userId: user.id, authorization: `Bearer ${token}` };
}

/**
 * 행위자 토큰 재발급 — **매트릭스 각 행 판정의 독립성 보장.**
 *
 * 일부 라우트는 성공 부작용으로 행위자 자신의 세션을 폐기한다(pv 증가 — 예: 온보딩
 * 비밀번호 설정). 토큰을 한 번만 발급하면 그 라우트 이후의 모든 행이 401 로 죽는데,
 * 401 도 'deny' 로 접히므로 **권한 판정이 아니라 세션 상태가 골든에 굳는다.**
 * 실제로 매트릭스 후반부 행들이 이렇게 오염된 채 잠복해 있었고(뒤 행들이 우연히 전부
 * deny 라 안 보였다), board 행 추가(WP-B1)에서 드러났다. 현재 pv 로 다시 서명해
 * 각 (엔드포인트 × 행위자) 판정을 세션 이력과 무관하게 만든다.
 */
export async function refreshActorToken(
  prisma: PrismaClient,
  tokens: TokenService,
  tenantId: string,
  actor: RowActor,
): Promise<void> {
  if (!actor.userId) return; // anonymous
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  const token = await tokens.signAccess({ sub: user.id, tenant: tenantId, pv: user.perm_version });
  actor.authorization = `Bearer ${token}`;
}
