/**
 * 시스템 설정 프로비저닝 (개발·CI 전용).
 *
 * 운영 설정의 출처는 **DB 한 곳**이고 애플리케이션은 환경 변수를 폴백으로 읽지 않는다.
 * 그러면 개발·CI 처럼 사람이 화면을 열 수 없는 환경에서 스토리지에 붙을 방법이 없어지므로,
 * **환경 변수를 DB 로 옮겨 심는 이 스크립트**가 그 자리를 맡는다.
 *
 * 런타임 폴백이 아니라 프로비저닝이라는 점이 중요하다 — 실행하지 않으면 설정이 없는 것이고,
 * "어디선가 환경 변수를 읽고 있을지도 모른다"는 모호함이 남지 않는다.
 *
 * 사용: pnpm tsx scripts/seed-settings.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { seal } from '../apps/api/src/settings/secret-box';
import { DEFAULT_TENANT_ID } from '../db/seeds/permissions';

interface Entry {
  category: string;
  key: string;
  value: string | undefined;
  secret?: boolean;
}

const ENTRIES: Entry[] = [
  { category: 'mail', key: 'transport', value: process.env.MAIL_TRANSPORT ?? 'console' },
  { category: 'mail', key: 'host', value: process.env.SMTP_HOST },
  { category: 'mail', key: 'port', value: process.env.SMTP_PORT },
  { category: 'mail', key: 'user', value: process.env.SMTP_USER },
  { category: 'mail', key: 'password', value: process.env.SMTP_PASSWORD, secret: true },
  { category: 'mail', key: 'from', value: process.env.SMTP_FROM },
  { category: 'storage', key: 'endpoint', value: process.env.STORAGE_ENDPOINT },
  { category: 'storage', key: 'bucket', value: process.env.STORAGE_BUCKET ?? 'stonex' },
  { category: 'storage', key: 'region', value: process.env.STORAGE_REGION ?? 'us-east-1' },
  { category: 'storage', key: 'accessKey', value: process.env.STORAGE_ACCESS_KEY, secret: true },
  { category: 'storage', key: 'secretKey', value: process.env.STORAGE_SECRET_KEY, secret: true },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  const tenantId = process.env.SEED_TENANT_ID ?? DEFAULT_TENANT_ID;

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    // 테넌트가 없으면 만든다 — 테스트 DB 는 시드를 돌리지 않은 상태일 수 있다
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: 'default' },
    });

    let written = 0;
    for (const entry of ENTRIES) {
      if (entry.value === undefined || entry.value === '') continue;
      const isSecret = entry.secret === true;
      await prisma.systemSetting.upsert({
        where: {
          tenant_id_category_key: { tenant_id: tenantId, category: entry.category, key: entry.key },
        },
        update: {
          value: isSecret ? null : entry.value,
          secret_value: isSecret ? seal(entry.value) : null,
          is_secret: isSecret,
        },
        create: {
          tenant_id: tenantId,
          category: entry.category,
          key: entry.key,
          value: isSecret ? null : entry.value,
          secret_value: isSecret ? seal(entry.value) : null,
          is_secret: isSecret,
        },
      });
      written += 1;
    }
    console.log(`설정 프로비저닝 완료: ${written}개 항목 (테넌트 ${tenantId})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
