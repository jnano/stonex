// Prisma 7 설정. .env는 자동 로드되지 않으므로 명시 로드한다.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'db/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
  migrations: {
    path: 'db/migrations',
    seed: 'tsx db/seeds/run.ts',
  },
});
