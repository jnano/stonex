import 'reflect-metadata';
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
  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
