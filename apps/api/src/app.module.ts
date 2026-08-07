import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * 루트 모듈.
 * WP-3에서 전역 Guard(AuthGuard → PermissionGuard → DominanceGuard)와
 * 미선언 엔드포인트 기동 차단(기획서 §7.3)이 여기에 등록된다.
 */
@Module({
  controllers: [HealthController],
})
export class AppModule {}
