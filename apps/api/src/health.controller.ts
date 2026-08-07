import { Controller, Get } from '@nestjs/common';

/**
 * 헬스체크 엔드포인트.
 * 주: WP-3에서 @Public() 데코레이터 체계가 도입되면 본 컨트롤러에 @Public() 명시가 필수가 된다
 * (미선언 엔드포인트는 서버 기동 실패 — 기획서 §7.3).
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
