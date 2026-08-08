/**
 * 개발 전용 로그인의 **배포 차단**을 고정하는 테스트.
 *
 * 이 기능은 편의 장치지만 잘못 배포되면 인증 우회 백도어다. 그래서 "동작한다"보다
 * **"배포에서는 존재하지 않는다"** 를 더 강하게 검증한다:
 *  - 플래그가 없으면 라우트가 등록되지 않는다 (기본값 없음 — 잊어서 켜지지 않는다)
 *  - production 이면 플래그가 있어도 등록되지 않는다
 *  - production + 플래그 조합은 기동을 실패시킨다 (조용히 무시하면 다음 배포에 또 실린다)
 */
import {
  DevLoginController,
  assertDevLoginNotInProduction,
  devLoginControllers,
  isDevLoginEnabled,
} from '../src/auth/dev-login';

describe('개발 전용 로그인 — 배포 차단', () => {
  it('플래그가 없으면 꺼져 있다 (기본값 없음)', () => {
    expect(isDevLoginEnabled({})).toBe(false);
    expect(isDevLoginEnabled({ NODE_ENV: 'development' })).toBe(false);
    // 오타·다른 값도 켜지지 않는다 — '1' 만 인정
    expect(isDevLoginEnabled({ DEV_LOGIN: 'true' })).toBe(false);
    expect(isDevLoginEnabled({ DEV_LOGIN: 'yes' })).toBe(false);
  });

  it('production 이면 플래그가 있어도 꺼진다', () => {
    expect(isDevLoginEnabled({ DEV_LOGIN: '1', NODE_ENV: 'production' })).toBe(false);
    expect(isDevLoginEnabled({ DEV_LOGIN: '1', NODE_ENV: 'development' })).toBe(true);
  });

  it('꺼져 있으면 컨트롤러가 등록 목록에 들어가지 않는다 — 라우트 자체가 없다', () => {
    // 인가 판정 이전에 404 다. 라우트가 없으면 G-1 매트릭스에도 나타나지 않는다
    expect(devLoginControllers({})).toEqual([]);
    expect(devLoginControllers({ DEV_LOGIN: '1', NODE_ENV: 'production' })).toEqual([]);
    expect(devLoginControllers({ DEV_LOGIN: '1', NODE_ENV: 'development' })).toEqual([DevLoginController]);
  });

  it('production 에서 플래그가 켜져 있으면 기동을 실패시킨다', () => {
    // 조용히 무시하면 "왜 안 되지" 로 끝나고 같은 설정이 다음 배포에 또 실린다
    expect(() => assertDevLoginNotInProduction({ NODE_ENV: 'production', DEV_LOGIN: '1' }))
      .toThrow(/프로덕션에서 사용할 수 없습니다/);
    // 정상 조합은 통과
    expect(() => assertDevLoginNotInProduction({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertDevLoginNotInProduction({ NODE_ENV: 'development', DEV_LOGIN: '1' })).not.toThrow();
  });

  it('검증 앱(test-app)은 개발 로그인을 강제로 끈다 — 개발자 .env 가 골든을 흔들지 않게', async () => {
    process.env.DEV_LOGIN = '1';
    await import('./support/test-app'); // 로드 시점에 플래그를 지운다
    expect(process.env.DEV_LOGIN).toBeUndefined();
  });
});
