/**
 * 시드 실행기 (기획서 §13.1). 멱등(idempotent) — 재실행 시 upsert.
 * 실행: pnpm db:seed  (DATABASE_URL, SEED_SUPER_ADMIN_EMAIL/PASSWORD 필요)
 */
import 'dotenv/config';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from '@node-rs/argon2';
import { DEFAULT_TENANT_ID, PERMISSIONS, ROLES, expandWildcards } from './permissions';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  try {
    // 1) 기본 테넌트 (고정 UUID)
    await prisma.tenant.upsert({
      where: { id: DEFAULT_TENANT_ID },
      update: {},
      create: { id: DEFAULT_TENANT_ID, name: 'default', status: 'ACTIVE' },
    });

    // 2) Permission 26종
    for (const p of PERMISSIONS) {
      await prisma.permission.upsert({
        where: { code: p.code },
        update: { description: p.description, scope: p.scope, module: p.module },
        create: { code: p.code, description: p.description, scope: p.scope, module: p.module },
      });
    }

    // 3) 역할 5종 + 매핑 (와일드카드는 여기서 전개 — 런타임 도달 금지 §4.2)
    for (const r of ROLES) {
      const role = await prisma.role.upsert({
        where: { tenant_id_code: { tenant_id: DEFAULT_TENANT_ID, code: r.code } },
        update: { name: r.name, display_order: r.displayOrder, requires_2fa: r.requires2fa, is_system: r.isSystem },
        create: {
          tenant_id: DEFAULT_TENANT_ID, code: r.code, name: r.name,
          display_order: r.displayOrder, requires_2fa: r.requires2fa, is_system: r.isSystem,
        },
      });
      const codes = expandWildcards(r.permissions);
      const perms = await prisma.permission.findMany({ where: { code: { in: codes } } });
      // 매핑은 전체 치환: 정의에서 빠진 매핑은 제거하여 시드 = 상태를 보장
      await prisma.rolePermission.deleteMany({
        where: { role_id: role.id, permission_id: { notIn: perms.map((p) => p.id) } },
      });
      for (const p of perms) {
        await prisma.rolePermission.upsert({
          where: { role_id_permission_id: { role_id: role.id, permission_id: p.id } },
          update: {},
          create: { tenant_id: DEFAULT_TENANT_ID, role_id: role.id, permission_id: p.id },
        });
      }
    }

    // 4) 최초 SUPER_ADMIN (환경 변수 기반 — 하드코딩 금지, §13.1)
    //    status=ACTIVE + 온보딩 플래그(§8.5): 비밀번호 변경·TOTP 등록 완료 전 온보딩 API 외 접근 불가
    const email = process.env.SEED_SUPER_ADMIN_EMAIL;
    const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
    if (!email || !password) {
      throw new Error('SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD 환경 변수가 필요합니다.');
    }
    /**
     * **이미 살아 있는 SUPER_ADMIN 이 있으면 새로 만들지 않는다.**
     *
     * 시드는 upsert 라 멱등이지만, 그 기준은 `이메일`이다. 최초 관리자가 이메일을
     * 바꾼 뒤(MEM-1) 시드를 다시 돌리면 "그 이메일 계정이 없네" 하고 **두 번째
     * 최고관리자를 만든다** — 실제로 발생했다. 최고관리자는 시스템의 최상위 권한이라
     * 의도치 않게 늘어나는 것 자체가 사고다(§10.1 이 그 수를 지키는 이유).
     *
     * 권한·역할 시드는 그대로 돌리고 관리자 생성만 건너뛴다 — 재실행의 목적은
     * 대개 권한 갱신이지 관리자 추가가 아니다.
     */
    const existingSuperAdmins = await prisma.user.count({
      where: {
        tenant_id: DEFAULT_TENANT_ID,
        deleted_at: null,
        status: 'ACTIVE',
        user_roles: { some: { role: { code: 'SUPER_ADMIN' } } },
      },
    });
    if (existingSuperAdmins > 0) {
      console.log(
        '시드 완료: 테넌트 1, Permission %d, 역할 %d — 활성 SUPER_ADMIN %d명이 이미 있어 관리자 생성은 건너뜁니다.',
        PERMISSIONS.length, ROLES.length, existingSuperAdmins,
      );
      return;
    }

    const passwordHash = await hash(password, { algorithm: 2 /* argon2id */ });
    const admin = await prisma.user.upsert({
      where: { tenant_id_email: { tenant_id: DEFAULT_TENANT_ID, email } },
      update: {},
      create: {
        tenant_id: DEFAULT_TENANT_ID,
        email,
        password_hash: passwordHash,
        name: '최고관리자',
        status: 'ACTIVE',
        must_change_password: true,
        totp_enrollment_required: true,
      },
    });
    const superRole = await prisma.role.findUniqueOrThrow({
      where: { tenant_id_code: { tenant_id: DEFAULT_TENANT_ID, code: 'SUPER_ADMIN' } },
    });
    await prisma.userRole.upsert({
      where: { user_id_role_id: { user_id: admin.id, role_id: superRole.id } },
      update: {},
      create: { tenant_id: DEFAULT_TENANT_ID, user_id: admin.id, role_id: superRole.id },
      // SUPER_ADMIN은 expires_at 지정 불가(§4.5) — 시드에서도 무기한
    });

    console.log('시드 완료: 테넌트 1, Permission %d, 역할 %d, SUPER_ADMIN(%s)', PERMISSIONS.length, ROLES.length, email);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
