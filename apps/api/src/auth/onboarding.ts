/**
 * 온보딩 게이트 (기획서 §8.5 — RT-8 해소).
 *
 * 상태(status)와 온보딩은 분리된 개념이다: 온보딩 미완료 계정도 status=ACTIVE 이며
 * 로그인은 가능하되, 세션의 접근 범위가 온보딩 API 로만 제한된다.
 * (계정을 비활성으로 두면 "로그인해야 활성화 / 활성화해야 로그인"의 순환이 생긴다)
 *
 * 최초 SUPER_ADMIN 시드와 requires_2fa 역할 부여 시의 재로그인 강제가 동일한 이 게이트를 쓴다.
 */

/** 온보딩 미완료 상태에서 허용되는 경로 (Nest 전역 프리픽스 제외한 경로) */
export const ONBOARDING_ALLOWED_PATHS: readonly string[] = [
  'auth/onboarding/password', // 비밀번호 변경
  'auth/onboarding/totp', // TOTP 등록 시작
  'auth/onboarding/totp/confirm', // TOTP 등록 확인
  'auth/onboarding/status', // 남은 온보딩 항목 조회
  'auth/logout',
];

export interface OnboardingFlags {
  mustChangePassword: boolean;
  totpEnrollmentRequired: boolean;
}

export function isOnboardingComplete(flags: OnboardingFlags): boolean {
  return !flags.mustChangePassword && !flags.totpEnrollmentRequired;
}

/** 온보딩 미완료 세션이 해당 경로에 접근 가능한가 */
export function isPathAllowedDuringOnboarding(path: string): boolean {
  const normalized = path.replace(/^\/+/, '').replace(/^api\/v1\//, '').replace(/\/+$/, '');
  return ONBOARDING_ALLOWED_PATHS.includes(normalized);
}
