import tseslint from 'typescript-eslint';
import { g2RestrictedSyntax, g2WebRestrictedSyntax } from './governance/eslint-rules/g2-rules.mjs';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'docs/**', '_to_delete/**', 'packages/db/generated/**', 'apps/web/next-env.d.ts' /* Next 생성 파일 */],
  },
  ...tseslint.configs.recommended,
  {
    // G-2 게이트: 전 소스에 적용, 예외(disable 주석) 발견 시 코드 리뷰에서 반려
    rules: {
      'no-restricted-syntax': ['error', ...g2RestrictedSyntax],
    },
  },
  {
    // 프론트엔드: 표시 분기가 보안 경계로 변질되는 것을 막는다(§3·§8.4).
    // lib/session.tsx 는 can() 의 **구현체**이므로 유일한 예외다 — 여기서 한 번만 권한 배열을 본다.
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    ignores: ['apps/web/lib/session.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...g2RestrictedSyntax, ...g2WebRestrictedSyntax],
    },
  },
  {
    // 승인된 예외: 시드 검증 도구는 display_order를 "정의 vs DB 동일성 대조"로만 비교한다
    // (보안 판정 아님 — INV-2의 취지 밖). role 비교 룰은 유지된다.
    files: ['db/seeds/verify.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...g2RestrictedSyntax.filter((r) => !r.selector.includes('display_order')),
      ],
    },
  },
);
