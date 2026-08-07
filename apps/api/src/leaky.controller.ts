import { Controller, Get } from '@nestjs/common';

/** G-5 실증용 — 권한 선언 없는 엔드포인트 (병합 금지) */
@Controller('leaky')
export class LeakyController {
  @Get()
  leak(): string {
    return 'undeclared';
  }
}
