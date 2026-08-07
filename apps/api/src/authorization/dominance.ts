/**
 * 관리 서열(Dominance) 판정 — 기획서 §4.6. 순수 함수.
 * 등수·레벨 없이 유효 Permission 집합 비교로만 판정한다(INV-2).
 * 판정 사유(부족 Permission 목록)를 함께 반환한다 — 관리 콘솔 표시(§4.6-3)와
 * 권한 시뮬레이터(ADM-5)가 동일 구조체를 재사용한다.
 */

export interface DominanceResult {
  allowed: boolean;
  /** 판정 근거 코드 */
  reason: 'DOMINANT' | 'SELF_TARGET' | 'EQUAL_SET' | 'INCOMPARABLE' | 'NOT_SUPERSET';
  /** 행위자에게 없어서 판정을 막은 대상측 Permission 목록 (표시용) */
  missing: string[];
}

/**
 * 우위 검사 (§4.6-1): 관리 행위(member.update/ban/role.assign/delete)는
 * 행위자 집합 ⊋ 대상자 집합(진부분집합 포함)일 때만 허용.
 * 동집합(동급 상호 공격)·비교불가(각자 상대에 없는 권한 보유)는 거부.
 * 본인 대상은 전면 금지.
 * 주: 이 규칙의 파생으로 SUPER_ADMIN 상호 무력화는 시스템 내 경로가 없다 —
 * 비상 회수는 break-glass(§10.1, Phase 1)·쿼럼(§9.5, Phase 3)이 담당한다.
 */
export function checkDominance(
  actorId: string,
  actorPerms: ReadonlySet<string>,
  targetId: string,
  targetPerms: ReadonlySet<string>,
): DominanceResult {
  if (actorId === targetId) {
    return { allowed: false, reason: 'SELF_TARGET', missing: [] };
  }
  const missing = [...targetPerms].filter((p) => !actorPerms.has(p));
  if (missing.length > 0) {
    // 대상이 행위자에게 없는 권한을 보유 → 비교불가 또는 역전
    return { allowed: false, reason: 'INCOMPARABLE', missing };
  }
  if (actorPerms.size === targetPerms.size) {
    // 부족분 없음 + 크기 동일 = 동집합 (동급 관리자 상호 공격 차단)
    return { allowed: false, reason: 'EQUAL_SET', missing: [] };
  }
  return { allowed: true, reason: 'DOMINANT', missing: [] };
}

export interface SubsetResult {
  allowed: boolean;
  /** 행위자가 보유하지 않아 부여할 수 없는 역할측 Permission 목록 */
  missing: string[];
}

/**
 * 역할 부여 조건 (§4.6-2): 부여/회수하려는 역할 R의 집합 ⊆ 행위자 집합.
 * 자신이 갖지 못한 권한이 담긴 역할은 부여 불가 → 공모 계정 간접 상승 차단.
 * SUPER_ADMIN(전체 집합)은 이 규칙만으로 "기존 SUPER_ADMIN만 부여 가능"이 도출된다.
 */
export function checkRoleSubset(
  rolePerms: ReadonlySet<string>,
  actorPerms: ReadonlySet<string>,
): SubsetResult {
  const missing = [...rolePerms].filter((p) => !actorPerms.has(p));
  return { allowed: missing.length === 0, missing };
}
