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
    // 한국어 제목에 WP-0·G-2·DB 같은 라틴 약어가 섞이면 대문자 제목으로 오판되므로 해제
    'subject-case': [0],
  },
};
