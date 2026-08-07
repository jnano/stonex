import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Redis 접속 래퍼 (기획서 §8.3).
 *
 * 캐시는 **참조 사본**이며 권위 소스가 아니다(권위 소스는 DB의 users.perm_version).
 * 따라서 Redis 장애는 서비스 중단이 아니라 성능 저하로만 나타나야 한다 —
 * 모든 연산은 실패 시 null/무시로 degrade 하고, 호출자는 DB 폴백으로 진행한다(§11 가용성).
 * REDIS_URL 미설정 시에는 아예 비활성(항상 미적중)으로 동작한다.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis | null;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn('REDIS_URL 미설정 — 권한 스냅샷 캐시 비활성(매 요청 DB 재구성)');
      this.client = null;
      return;
    }
    this.client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // 장애 시 큐에 쌓지 않고 즉시 실패 → DB 폴백
      lazyConnect: false,
      connectTimeout: 2000,
      // 재연결은 유한하게 — 무한 재시도는 이벤트 루프를 붙잡아 프로세스 종료를 막는다.
      // 포기 후에는 캐시 비활성 상태로 계속 동작한다(DB 폴백).
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
    });
    // 연결 실패는 로그만 남긴다 — 처리되지 않은 error 이벤트가 프로세스를 죽이는 것을 막는다
    this.client.on('error', (e) => this.logger.warn(`Redis 오류(폴백 동작): ${e.message}`));
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(key);
    } catch {
      return null; // 캐시 미적중과 동일하게 취급
    }
  }

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(key, value, 'EX', seconds);
    } catch {
      // 캐시 기록 실패는 무시 — 다음 요청이 DB에서 재구성한다
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (e) {
      // 삭제 실패는 stale 캐시를 남기지만, pv 불일치 백스톱이 이를 잡는다(§8.3)
      this.logger.warn(`캐시 무효화 실패(pv 백스톱으로 방어): ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
