import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './authorization/decorators';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './cache/redis.service';
import { StorageService } from './storage/storage.service';

interface ReadyReport {
  status: 'ok' | 'degraded';
  checks: { db: boolean; redis: boolean; storage: boolean };
}

/** readiness 결과 캐시 — 헬스체크가 의존성에 부하를 주지 않게 한다 */
const READY_CACHE_MS = 5_000;

/**
 * 헬스체크 (작업지시서 WP-9 항목 8).
 *
 * liveness 와 readiness 를 분리한다. 상수를 반환하는 헬스체크는 스토리지 자격 증명 만료나
 * 커넥션 풀 고갈 상태에서도 200을 반환하므로, 로드밸런서가 죽은 인스턴스에 트래픽을 계속 보낸다.
 */
@Controller('health')
export class HealthController {
  private cached: { at: number; report: ReadyReport } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  /** liveness — 프로세스가 살아 있는지만 본다. 의존성 장애로 재시작되면 안 되므로 점검하지 않는다 */
  @Public()
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }

  @Public()
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** readiness — 의존성을 실제로 점검한다. 하나라도 실패하면 503 */
  @Public()
  @Get('ready')
  async ready(): Promise<ReadyReport> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < READY_CACHE_MS) {
      return this.assert(this.cached.report);
    }

    const [db, redis, storage] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      // Redis 는 캐시라 장애가 서비스 중단은 아니지만(§11 DB 폴백), 상태는 드러내야 한다
      this.redis.enabled ? this.redis.get('health:probe').then(() => true).catch(() => false) : true,
      this.storage.ping(),
    ]);

    const report: ReadyReport = {
      status: db && redis && storage ? 'ok' : 'degraded',
      checks: { db, redis, storage },
    };
    this.cached = { at: now, report };
    return this.assert(report);
  }

  private assert(report: ReadyReport): ReadyReport {
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }
}
