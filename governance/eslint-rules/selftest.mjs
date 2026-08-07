// G-2 룰 자가 검증: 알려진 위반 코드가 반드시 검출되는지 확인한다.
// 룰이 조용히 무력화(설정 누락·셀렉터 오타)되면 이 스크립트가 CI lint 잡을 실패시킨다.
import { ESLint } from 'eslint';
import { g2RestrictedSyntax } from './g2-rules.mjs';

const VIOLATIONS = [
  { code: `if (role === 'ADMIN') { grant(); }`, name: 'role 식별자 비교' },
  { code: `if (user.role !== 'MEMBER') { deny(); }`, name: 'member 표현식 role 비교' },
  { code: `if (a.display_order >= 30) { allow(); }`, name: 'display_order 비교' },
  { code: `if (roleA.displayOrder > roleB.displayOrder) { manage(); }`, name: 'displayOrder 비교' },
];
const CLEAN = [
  { code: `const ok = await can(subject, 'file.delete', file);`, name: 'can() 정상 사용' },
  { code: `roles.sort((a, b) => a.display_order - b.display_order);`, name: '정렬 용도(비교 연산 아님)' },
];

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      // flat config는 기본적으로 .ts를 검사하지 않으므로 명시 (누락 시 이 selftest가 실패한다)
      files: ['**/*.ts', '**/*.tsx', '**/*.js'],
      rules: { 'no-restricted-syntax': ['error', ...g2RestrictedSyntax] },
    },
  ],
});

let failed = false;
for (const v of VIOLATIONS) {
  const [res] = await eslint.lintText(v.code, { filePath: 'sample.ts' });
  if (res.errorCount === 0) {
    console.error(`G-2 selftest 실패: 위반 미검출 — ${v.name}`);
    failed = true;
  }
}
for (const c of CLEAN) {
  const [res] = await eslint.lintText(c.code, { filePath: 'sample.ts' });
  const g2Errors = res.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
  if (g2Errors.length > 0) {
    console.error(`G-2 selftest 실패: 오탐 — ${c.name}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`G-2 selftest 통과 (위반 검출 ${VIOLATIONS.length}건, 오탐 0건)`);
