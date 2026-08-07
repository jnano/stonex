import tseslint from 'typescript-eslint';
import { g2RestrictedSyntax } from './governance/eslint-rules/g2-rules.mjs';

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
