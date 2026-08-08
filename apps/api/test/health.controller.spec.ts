import { HealthController } from '../src/health.controller';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RedisService } from '../src/cache/redis.service';
import type { StorageService } from '../src/storage/storage.service';

const controllerWith = (opts: { db: boolean; redis: boolean; storage: boolean }) =>
  new HealthController(
    {
      $queryRaw: () => (opts.db ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('db down'))),
    } as unknown as PrismaService,
    {
      enabled: true,
      get: () => (opts.redis ? Promise.resolve(null) : Promise.reject(new Error('redis down'))),
    } as unknown as RedisService,
    { ping: () => Promise.resolve(opts.storage) } as unknown as StorageService,
  );

describe('HealthController', () => {
  it('liveness 는 의존성과 무관하게 ok 를 반환한다', () => {
    const controller = controllerWith({ db: false, redis: false, storage: false });
    expect(controller.check()).toEqual({ status: 'ok' });
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('readiness 는 의존성이 모두 정상일 때 ok 를 반환한다', async () => {
    const controller = controllerWith({ db: true, redis: true, storage: true });
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      checks: { db: true, redis: true, storage: true },
    });
  });

  it('스토리지 장애 시 readiness 가 503 으로 전환된다 (WP-9 DoD)', async () => {
    const controller = controllerWith({ db: true, redis: true, storage: false });
    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
  });

  it('DB 장애도 readiness 실패로 드러난다', async () => {
    const controller = controllerWith({ db: false, redis: true, storage: true });
    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
  });
});
