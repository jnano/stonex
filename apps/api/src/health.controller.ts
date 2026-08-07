import { Controller, Get } from '@nestjs/common';
import { Public } from './authorization/decorators';

/** 헬스체크 — 공개 엔드포인트임을 명시(§7.3, 암묵적 공개 금지) */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
