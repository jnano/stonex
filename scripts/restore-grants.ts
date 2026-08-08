/**
 * L-1 자동 회수 복구 스크립트 (WP-14).
 *
 * 순찰이 자동 회수한 Grant 를 **감사 로그의 `detail.before` 로부터 되살린다.**
 * 자동 조치는 blast-radius 상한으로 규모를 제한하지만, 불변식 정의가 틀렸을 때는
 * 정상 Grant 가 지워질 수 있다 — 그때 되돌릴 수단이 없으면 자동 조치를 켤 수 없다.
 *
 * 사용:
 *   pnpm tsx scripts/restore-grants.ts --since 2026-08-08T00:00:00Z [--ri RI-3] [--apply]
 *
 * 기본은 **미리보기(dry-run)** 이며, `--apply` 를 붙여야 실제로 삽입한다.
 * 이미 같은 (주체·리소스·권한) 조합이 있으면 건너뛴다 — 재실행해도 안전하다.
 */
import 'dotenv/config';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';

interface RevokedRow {
  id: string;
  tenantId: string;
  subjectType: string;
  subject: string;
  resourceType: string;
  resourceId: string;
  permissionId: string;
  effect: string;
  grantedBy: string;
  expiresAt: string | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  const since = arg('since');
  if (!since) throw new Error('--since <ISO8601> 이 필요합니다 (복구 대상 시각 하한).');
  const riFilter = arg('ri');
  const apply = process.argv.includes('--apply');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    // 순찰의 자동 회수는 actor_id 가 NULL(시스템 행위)이고 detail.reason 에 RI 번호가 담긴다
    const logs = await prisma.$queryRawUnsafe<Array<{ detail: { before: RevokedRow; reason?: string } }>>(
      `SELECT detail FROM audit.audit_logs
        WHERE action = 'grant.revoke'
          AND actor_id IS NULL
          AND created_at >= $1::timestamptz
          AND ($2::text IS NULL OR detail->>'reason' LIKE $2 || '%')
        ORDER BY created_at`,
      since,
      riFilter ?? null,
    );

    console.log(`대상 ${logs.length}건 (${apply ? '적용' : '미리보기'})`);
    let restored = 0;
    let skipped = 0;
    for (const log of logs) {
      const row = log.detail?.before;
      if (!row?.id) {
        skipped += 1;
        continue;
      }
      const exists = await prisma.resourceGrant.findFirst({
        where: {
          subject_type: row.subjectType, subject_id: row.subject,
          resource_type: row.resourceType, resource_id: row.resourceId,
          permission_id: row.permissionId,
        },
        select: { id: true },
      });
      if (exists) {
        skipped += 1;
        continue;
      }
      console.log(
        `  ${row.resourceType}:${row.resourceId} → ${row.subject} (${row.effect}) — ${log.detail.reason ?? ''}`,
      );
      if (apply) {
        await prisma.resourceGrant.create({
          data: {
            id: row.id, // 원래 id 로 되살려 감사 추적이 이어지게 한다
            tenant_id: row.tenantId,
            subject_type: row.subjectType,
            subject_id: row.subject,
            resource_type: row.resourceType,
            resource_id: row.resourceId,
            permission_id: row.permissionId,
            effect: row.effect,
            granted_by: row.grantedBy,
            expires_at: row.expiresAt ? new Date(row.expiresAt) : null,
          },
        });
      }
      restored += 1;
    }
    console.log(`${apply ? '복구' : '복구 예정'} ${restored}건, 건너뜀 ${skipped}건`);
    if (!apply) console.log('실제로 되돌리려면 --apply 를 붙여 다시 실행하세요.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
