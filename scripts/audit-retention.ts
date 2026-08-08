/**
 * 감사 로그 보존 배치 — **관리자 자격 전용** (WP-15, WT-21).
 *
 * 애플리케이션은 감사 로그를 지우지 않는다(§10.3 append-only). `stonex_app` 역할에는 DELETE
 * 권한이 없고, 앱 코드에 삭제문을 두면 G-2 룰이 막는다. 감사 로그를 지울 수 있는 코드가
 * 앱 안에 있으면 append-only 는 규약일 뿐 보증이 아니기 때문이다.
 *
 * 그래서 조회 접근 로그(`access.read`)의 단기 보존은 이 스크립트가 맡는다. 운영에서는
 * 관리자 자격으로 스케줄한다.
 *
 * 왜 차등을 두나: `AuditInterceptor` 가 전역이라 인증된 모든 GET 이 `access.read` 1행을 만든다.
 * Phase 2 가 파일·도메인 목록처럼 트래픽이 높은 엔드포인트를 얹었으므로, 이 유형을 권한 변경
 * 기록과 같은 기간 보관하면 디스크가 먼저 찬다.
 *
 * 사용: pnpm tsx scripts/audit-retention.ts [--days 90] [--apply]
 */
import 'dotenv/config';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  const days = Number(arg('days') ?? process.env.AUDIT_ACCESS_RETENTION_DAYS ?? 90);
  const apply = process.argv.includes('--apply');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const [target] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM audit.audit_logs
        WHERE action = 'access.read' AND created_at < now() - ($1 || ' days')::interval`,
      String(days),
    );
    console.log(`대상 ${target.n}행 (access.read, ${days}일 경과) — ${apply ? '삭제' : '미리보기'}`);
    if (!apply) {
      console.log('실제로 지우려면 --apply 를 붙여 다시 실행하세요.');
      return;
    }
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM audit.audit_logs
        WHERE action = 'access.read' AND created_at < now() - ($1 || ' days')::interval`,
      String(days),
    );
    console.log(`삭제 완료: ${deleted}행`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
