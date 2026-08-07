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
  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
