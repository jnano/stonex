import tseslint from 'typescript-eslint';
import { g2RestrictedSyntax } from './governance/eslint-rules/g2-rules.mjs';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'docs/**', '_to_delete/**'],
  },
  ...tseslint.configs.recommended,
  {
    // G-2 게이트: 전 소스에 적용, 예외(disable 주석) 발견 시 코드 리뷰에서 반려
    rules: {
      'no-restricted-syntax': ['error', ...g2RestrictedSyntax],
    },
  },
);
