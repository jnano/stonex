/**
 * 통합 검증용 앱 하니스 (WP-8).
 *
 * 실제 AppModule 을 그대로 부팅한다 — Guard 체계·데코레이터·직렬화가 운영과 동일하게 동작해야
 * 매트릭스(G-1)와 공격 시나리오(G-3)가 의미를 갖는다. 모듈을 흉내 내면 검증이 허구가 된다.
 */
import * as path from 'node:path';
import { config } from 'dotenv';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';

const ROOT = path.resolve(__dirname, '../../../..');
config({ path: path.join(ROOT, '.env') });

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 검증은 실제 DB를 요구).');
}
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET ??= 'test-secret-value-at-least-32-characters-long';
/**
 * 개발 전용 로그인은 검증 앱에 **절대 섞이지 않는다**.
 * 개발자의 .env 에 DEV_LOGIN=1 이 있으면 그 라우트가 앱에 붙어 G-1 골든이 로컬과
 * CI 에서 달라진다 — 검증이 환경에 좌우되면 골든의 의미가 사라진다.
 * 이 경로를 검증하는 스펙은 스스로 켜고 끈다(dev-login.spec).
 */
delete process.env.DEV_LOGIN;

export async function createTestApp(): Promise<INestApplication> {
  const { AppModule } = await import('../../src/app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

export function createPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }) });
}

export const uid = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
