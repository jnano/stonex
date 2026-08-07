/** Dominance 단위 테스트 — WP-3 DoD: 동집합 거부·비교불가 거부·본인 금지·부분집합 부여 */
import { checkDominance, checkRoleSubset } from '../src/authorization/dominance';

const S = (...codes: string[]) => new Set(codes);

describe('우위 검사 (§4.6-1)', () => {
  it('진상위 집합이면 허용 (DOMINANT)', () => {
    const r = checkDominance('a', S('p1', 'p2', 'p3'), 'b', S('p1', 'p2'));
    expect(r).toEqual({ allowed: true, reason: 'DOMINANT', missing: [] });
  });

  it('동집합은 거부 — 동급 관리자 상호 공격 차단 (EQUAL_SET)', () => {
    const r = checkDominance('a', S('p1', 'p2'), 'b', S('p1', 'p2'));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('EQUAL_SET');
  });

  it('비교불가(상대가 내게 없는 권한 보유)는 거부 + 부족 목록 반환 (INCOMPARABLE)', () => {
    const r = checkDominance('a', S('p1', 'p2'), 'b', S('p1', 'p9'));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('INCOMPARABLE');
    expect(r.missing).toEqual(['p9']); // §4.6-3: 관리 콘솔이 사유로 표시
  });

  it('본인 대상은 집합과 무관하게 전면 금지 (SELF_TARGET)', () => {
    const r = checkDominance('a', S('p1', 'p2'), 'a', S());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('SELF_TARGET');
  });

  it('SUPER_ADMIN 동집합 상호 관리도 거부 — break-glass 전용 경로 (의도된 동작, RT-1)', () => {
    const all = S('p1', 'p2', 'p3', 'p4');
    expect(checkDominance('sa1', all, 'sa2', all).reason).toBe('EQUAL_SET');
  });
});

describe('역할 부여 부분집합 검사 (§4.6-2)', () => {
  it('역할 집합 ⊆ 행위자 집합이면 부여 가능', () => {
    expect(checkRoleSubset(S('p1'), S('p1', 'p2'))).toEqual({ allowed: true, missing: [] });
  });

  it('행위자 미보유 권한이 담긴 역할은 부여 불가 — 공모 간접 상승 차단', () => {
    const r = checkRoleSubset(S('p1', 'p9'), S('p1', 'p2'));
    expect(r.allowed).toBe(false);
    expect(r.missing).toEqual(['p9']);
  });

  it('동일 집합 역할은 부여 가능(⊆ 충족) — SUPER_ADMIN이 SUPER_ADMIN 부여하는 경로', () => {
    expect(checkRoleSubset(S('p1', 'p2'), S('p1', 'p2')).allowed).toBe(true);
  });
});
