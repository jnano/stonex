import 'reflect-metadata';
import * as path from 'node:path';
import { config } from 'dotenv';

// 저장소 루트의 .env 를 명시 경로로 읽는다. 실행 위치가 apps/api 라 자동 탐색으로는 찾지 못한다
// (테스트는 각자 dotenv 를 불러 왔기에 지금까지 드러나지 않았다).
config({ path: path.resolve(__dirname, '../../../.env') });
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONTROLLERS } from './app.controllers';
import { enforceEndpointDeclarations } from './authorization/startup-check';

/** 서버 부트스트랩. 포트는 환경변수 우선(하드코딩 금지). */
async function bootstrap(): Promise<void> {
  // 권한 미선언 엔드포인트가 있으면 여기서 기동 실패한다 (§7.3, INV-5)
  enforceEndpointDeclarations(CONTROLLERS);

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  // 입력 방향 화이트리스트(기획서 §10.2). DTO 에 선언되지 않은 필드는 거부한다 —
  // 입력 화이트리스트(ValidationPipe)는 **AppModule 의 APP_PIPE 로 옮겼다** —
  // bootstrap 에만 두면 테스트가 부팅하는 앱에는 적용되지 않아, 소유권 탈취를 막는
  // 이 방어를 G-1 매트릭스도 G-3 시나리오도 검증하지 못한다(WP-15에서 발견).
  /**
   * CORS — 허용 출처는 **환경 변수로만** 지정한다(하드코딩 금지).
   *
   * 와일드카드를 쓰지 않는 이유: 지금은 토큰을 Authorization 헤더로 보내 쿠키 자동 전송이
   * 없지만, 나중에 쿠키 기반으로 바꾸는 순간 `*` 는 그대로 사고 경로가 된다.
   * 목록을 좁게 유지하는 편이 그때 가서 기억해 내는 것보다 안전하다.
   */
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3002')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: false });

  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
