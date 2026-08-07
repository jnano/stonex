// 커밋 규약 (기획서 §16.3-3): Conventional Commits + 커스텀 타입
// perm: 권한 모델(permissions·roles·매핑·매트릭스) 변경 — G-1 골든 파일 동반 필수(CI perm-check)
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'ui', 'refactor', 'docs', 'test', 'chore', 'ci', 'build', 'perm'],
    ],
  },
};
