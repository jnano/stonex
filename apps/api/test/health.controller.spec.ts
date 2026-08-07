import { HealthController } from '../src/health.controller';

describe('HealthController', () => {
  it('상태 ok를 반환한다', () => {
    const controller = new HealthController();
    expect(controller.check()).toEqual({ status: 'ok' });
  });
});
