import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
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
  // 출력 화이트리스트만으로는 owner_id 같은 필드가 **들어오는** 것을 막지 못해
  // 공유 수령자가 소유권을 탈취하는 경로가 열린다(§10.1).
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
