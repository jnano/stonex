// Permission·역할 정의의 유일한 출처 (기획서 §16.2, §10.3)
// WP-1에서 작성한다: 기본 테넌트, Permission 26종(+scope·module), 역할 5종(+display_order·requires_2fa), 매핑.
// 와일드카드는 저장 전 개별 행으로 전개하며(§4.2), G-4가 시드 정합성을 검사한다.

export const SEED_NOT_READY = true; // WP-1 완료 시 제거
