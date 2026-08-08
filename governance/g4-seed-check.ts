/**
 * G-4 시드 정합성 검사 (작업지시서 WP-1 항목 3, 기획서 §14.2).
 * DB 없이 정의(db/seeds/permissions.ts)만 정적 검사한다. 실행: pnpm g4
 *
 * 검사 항목:
 *  1. 명명 규약(§4.2): 소문자 세그먼트 2~4개, '{리소스}.{행위}' 형식
 *  2. scope ∈ {global, owned}, module 비어있지 않음
 *  3. 전개(expand) 결과 중복 코드 부재
 *  4. Grant 화이트리스트(§4.4) 정합: 실존 코드만, file.share 제외(§10.1), transfer/delete 위임 금지
 *  5. `.all` 계열은 반드시 global scope
 *  6. 역할 정합: 매핑 코드 실존, SUPER_ADMIN=전체 집합, MEMBER·SUPER_ADMIN은 is_system,
 *     OPERATOR·SUPER_ADMIN은 requires_2fa=true (RT-11)
 */
import { GRANT_WHITELIST, PERMISSIONS, ROLES, ROLE_LATTICE, expandWildcards } from '../db/seeds/permissions';

const errors: string[] = [];
const codes = new Set(PERMISSIONS.map((p) => p.code));

// 1·2) 명명 규약·scope·module
const CODE_RE = /^[a-z]+(\.[a-z]+){1,3}$/;
for (const p of PERMISSIONS) {
  if (!CODE_RE.test(p.code)) errors.push(`명명 규약 위반(§4.2): ${p.code}`);
  if (p.scope !== 'global' && p.scope !== 'owned') errors.push(`scope 오류: ${p.code} → ${p.scope}`);
  if (!p.module) errors.push(`module 누락: ${p.code}`);
  if (!p.description) errors.push(`description 누락: ${p.code}`);
}

// 3) 중복
if (codes.size !== PERMISSIONS.length) {
  const seen = new Set<string>();
  for (const p of PERMISSIONS) {
    if (seen.has(p.code)) errors.push(`중복 Permission 코드: ${p.code}`);
    seen.add(p.code);
  }
}

// 5) .all 은 global 이어야 함
for (const p of PERMISSIONS) {
  if (p.code.endsWith('.all') && p.scope !== 'global') {
    errors.push(`.all 권한은 global 이어야 함: ${p.code} (${p.scope})`);
  }
}

// 4) Grant 화이트리스트 정합
for (const [resourceType, list] of Object.entries(GRANT_WHITELIST)) {
  for (const code of list) {
    if (!codes.has(code)) errors.push(`화이트리스트에 실존하지 않는 코드: ${resourceType} → ${code}`);
  }
}
// 재공유·재위임 전파 차단(§10.1): 어떤 리소스 타입이든 `{type}.share`는 Grant 부여 대상이 될 수 없다.
// (v1은 file 하드코딩이라 domain.share 신설 시 검사에서 누락됐다 — RT-4/WT-4)
for (const [resourceType, list] of Object.entries(GRANT_WHITELIST)) {
  const shareCode = `${resourceType}.share`;
  if (list.includes(shareCode)) {
    errors.push(`화이트리스트 위반: ${shareCode}는 Grant 부여 불가(재공유·재위임 전파 차단, §10.1)`);
  }
}
for (const banned of ['domain.transfer', 'file.delete', 'domain.delete']) {
  for (const [resourceType, list] of Object.entries(GRANT_WHITELIST)) {
    if (list.includes(banned)) errors.push(`화이트리스트 위반: ${banned}는 Grant 위임 불가(§4.4) — ${resourceType}`);
  }
}

// 6) 역할 정합
const roleCodes = new Set(ROLES.map((r) => r.code));
if (roleCodes.size !== ROLES.length) errors.push('중복 역할 코드 존재');
for (const r of ROLES) {
  for (const code of expandWildcards(r.permissions)) {
    if (!codes.has(code)) errors.push(`역할 ${r.code}의 매핑에 실존하지 않는 코드: ${code}`);
  }
}
const superAdmin = ROLES.find((r) => r.code === 'SUPER_ADMIN');
if (!superAdmin || expandWildcards(superAdmin.permissions).length !== PERMISSIONS.length) {
  errors.push('SUPER_ADMIN은 전체 Permission 집합이어야 함(§4.5)');
}
for (const code of ['MEMBER', 'SUPER_ADMIN']) {
  if (!ROLES.find((r) => r.code === code)?.isSystem) errors.push(`${code}는 is_system=true 여야 함(§10.3)`);
}
for (const code of ['OPERATOR', 'SUPER_ADMIN']) {
  if (!ROLES.find((r) => r.code === code)?.requires2fa) {
    errors.push(`${code}는 requires_2fa=true 여야 함(§10.4, RT-11)`);
  }
}

// 7) 역할 격자 (기획서 §14.3 RI-9의 CI 대응물)
//    상위 역할은 하위 역할의 **진상위 집합**이어야 한다. 이 격자가 깨지면 우위 검사(§4.6-1)가
//    INCOMPARABLE 을 반환해 상위 역할이 하위 회원을 정지·수정·삭제할 수 없게 된다(전 회원 관리 마비).
const permsOf = (code: string): Set<string> => {
  const role = ROLES.find((r) => r.code === code);
  if (!role) {
    errors.push(`격자 검사: 존재하지 않는 역할 ${code}`);
    return new Set();
  }
  return new Set(expandWildcards(role.permissions));
};
for (const { superior, inferior } of ROLE_LATTICE) {
  const sup = permsOf(superior);
  const inf = permsOf(inferior);
  const missing = [...inf].filter((c) => !sup.has(c));
  if (missing.length > 0) {
    errors.push(
      `역할 격자 붕괴: ${superior}가 ${inferior}의 권한을 포함하지 않음 — 누락 ${missing.join(', ')}. ` +
        `이 상태로 배포하면 ${superior}가 ${inferior} 보유 회원을 관리할 수 없다(§4.6-1 INCOMPARABLE).`,
    );
  } else if (sup.size === inf.size) {
    errors.push(`역할 격자 붕괴: ${superior}와 ${inferior}의 권한 집합이 동일 — 동집합은 상호 관리 불가(§4.6-1)`);
  }
}

if (errors.length > 0) {
  console.error(`G-4 시드 정합성 실패 — ${errors.length}건:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `G-4 시드 정합성 통과: Permission ${PERMISSIONS.length}종, 역할 ${ROLES.length}종, ` +
    `화이트리스트 ${Object.keys(GRANT_WHITELIST).length}종, 격자 ${ROLE_LATTICE.length}쌍`,
);
