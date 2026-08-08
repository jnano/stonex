/**
 * 시드 결과 검증 (WP-1 DoD 1: "기획서 §4.4·§4.5 표와 일치하는 상태 재현"의 표 대조 스크립트).
 * DB의 실제 상태를 정의 파일과 대조한다. 실행: pnpm db:verify
 */
import 'dotenv/config';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { DEFAULT_TENANT_ID, PERMISSIONS, ROLES, expandWildcards } from './permissions';

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
  });
  const errors: string[] = [];

  try {
    // Permission 대조 (코드·scope·module)
    const dbPerms = await prisma.permission.findMany();
    const dbByCode = new Map(dbPerms.map((p) => [p.code, p]));
    if (dbPerms.length !== PERMISSIONS.length) {
      errors.push(`Permission 수 불일치: DB ${dbPerms.length} vs 정의 ${PERMISSIONS.length}`);
    }
    for (const def of PERMISSIONS) {
      const db = dbByCode.get(def.code);
      if (!db) errors.push(`DB에 없음: ${def.code}`);
      else if (db.scope !== def.scope || db.module !== def.module) {
        errors.push(`속성 불일치: ${def.code} (scope ${db.scope}/${def.scope}, module ${db.module}/${def.module})`);
      }
    }

    // 역할·매핑 대조 (집합 동일성)
    for (const def of ROLES) {
      const role = await prisma.role.findUnique({
        where: { tenant_id_code: { tenant_id: DEFAULT_TENANT_ID, code: def.code } },
        include: { role_permissions: { include: { permission: true } } },
      });
      if (!role) { errors.push(`역할 없음: ${def.code}`); continue; }
      if (role.display_order !== def.displayOrder) errors.push(`${def.code} display_order 불일치`);
      if (role.requires_2fa !== def.requires2fa) errors.push(`${def.code} requires_2fa 불일치`);
      if (role.is_system !== def.isSystem) errors.push(`${def.code} is_system 불일치`);
      const dbSet = new Set(role.role_permissions.map((rp) => rp.permission.code));
      const defSet = new Set(expandWildcards(def.permissions));
      for (const c of defSet) if (!dbSet.has(c)) errors.push(`${def.code} 매핑 누락: ${c}`);
      for (const c of dbSet) if (!defSet.has(c)) errors.push(`${def.code} 잉여 매핑: ${c}`);
    }

    // SUPER_ADMIN 계정: 존재 + 온보딩 플래그 + 역할 보유 + 무기한
    const superRole = await prisma.role.findUnique({
      where: { tenant_id_code: { tenant_id: DEFAULT_TENANT_ID, code: 'SUPER_ADMIN' } },
      include: { user_roles: { include: { user: true } } },
    });
    const holders = superRole?.user_roles ?? [];
    if (holders.length < 1) errors.push('활성 SUPER_ADMIN 보유자 없음 (RI-1 위반 상태)');
    for (const ur of holders) {
      if (ur.expires_at !== null) errors.push('SUPER_ADMIN에 expires_at 지정됨(§4.5 위반)');
      if (!ur.user.must_change_password || !ur.user.totp_enrollment_required) {
        errors.push(`시드 SUPER_ADMIN(${ur.user.email})의 온보딩 플래그 미설정(§8.5)`);
      }
    }

    if (errors.length > 0) {
      console.error(`시드 검증 실패 — ${errors.length}건:`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(
      `시드 검증 통과: 기획서 §4.4(Permission ${PERMISSIONS.length}종)·§4.5(역할 ${ROLES.length}종) 표와 DB 상태 일치, ` +
        'SUPER_ADMIN 온보딩 플래그 확인',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
