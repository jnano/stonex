import { Inject, Injectable } from '@nestjs/common';
import { Decision, GrantStore, ResourceRef, SubjectSnapshot } from './types';

export const GRANT_STORE = Symbol('GRANT_STORE');

/**
 * 리소스 타입별 "접근 가능 상태" 집합 (§4.7 1단계).
 * readExtra: 해당 Permission 에 한해 추가 허용되는 상태 (도메인 조회의 SUSPENDED).
 * 복구 기능 도입 시 복구 전용 Permission 만 이 게이트를 우회하도록 확장한다.
 */
const RESOURCE_STATE_GATE: Record<
  string,
  { accessible: readonly string[]; readExtra?: { statuses: readonly string[]; permissions: readonly string[] } }
> = {
  file: { accessible: ['ACTIVE'] },
  domain: {
    accessible: ['UNVERIFIED', 'VERIFIED'],
    readExtra: { statuses: ['SUSPENDED'], permissions: ['domain.read', 'domain.read.all'] },
  },
};

/**
 * 특정 Permission 으로 접근 가능한 리소스 상태 집합 (§4.7 1단계의 목록 대응물).
 *
 * 목록 API 는 리소스를 하나씩 평가기에 넣지 않고 쿼리 한 방으로 행 범위를 정하므로,
 * 1단계 게이트를 **쿼리 조건으로 다시 써야 한다**. 그 조건을 손으로 적으면 §15.1 이중 구현이
 * 되고 게이트 표가 바뀔 때 목록만 뒤처진다 — 특히 도메인은 `readExtra` 때문에 조회 가능 상태가
 * 접근 가능 상태보다 넓어(SUSPENDED 포함) 손으로 옮겨 적으면 틀리기 쉽다.
 */
export function statusesAllowing(resourceType: string, permission: string): readonly string[] {
  const gate = RESOURCE_STATE_GATE[resourceType];
  if (!gate) return [];
  const extra =
    gate.readExtra && gate.readExtra.permissions.includes(permission) ? gate.readExtra.statuses : [];
  return [...gate.accessible, ...extra];
}

/**
 * 권한 평가기 (기획서 §4.7). 모든 권한 검사는 이 단일 함수를 통과한다(INV-1).
 * 평가 순서는 §4.7 그대로이며, 각 단계에서 결정되면 즉시 종료한다.
 * 프론트엔드·핸들러가 이 로직을 중복 구현하는 것을 금지한다.
 */
@Injectable()
export class AuthorizationService {
  constructor(@Inject(GRANT_STORE) private readonly grants: GrantStore) {}

  async can(subject: SubjectSnapshot, permission: string, resource?: ResourceRef): Promise<Decision> {
    // 0. 주체 상태 검사 — 정지·탈퇴·미인증 계정 전면 차단
    if (subject.status !== 'ACTIVE') {
      return { allow: false, step: 0, code: 'SUBJECT_NOT_ACTIVE', reason: `주체 상태 ${subject.status}` };
    }

    // 1. 리소스 상태 검사 (소프트 삭제·정지 리소스의 소유자/전역 경로 접근 차단)
    if (resource) {
      const gate = RESOURCE_STATE_GATE[resource.type];
      const accessible =
        gate !== undefined &&
        (gate.accessible.includes(resource.status) ||
          (gate.readExtra !== undefined &&
            gate.readExtra.statuses.includes(resource.status) &&
            gate.readExtra.permissions.includes(permission)));
      if (!accessible) {
        return {
          allow: false, step: 1, code: 'RESOURCE_STATE',
          reason: `리소스 상태 ${resource.type}:${resource.status} 접근 불가`,
        };
      }
    }

    // 2. 명시적 거부 검사 (INV-4: DENY는 모든 ALLOW에 우선 — 만료 여부와 무관하게 유효한 DENY만)
    const grantRows = resource
      ? await this.grants.findGrants(subject.id, resource.type, resource.id, permission)
      : [];
    const now = Date.now();
    const valid = grantRows.filter((g) => g.expiresAt === null || g.expiresAt.getTime() > now);
    if (resource && valid.some((g) => g.effect === 'DENY')) {
      return { allow: false, step: 2, code: 'EXPLICIT_DENY', reason: '명시적 DENY Grant' };
    }

    // 3. 역할 기반 허용 (scope 해석 — §4.3)
    const scope = subject.permissions.get(permission);
    if (scope === 'global') {
      return { allow: true, step: 3, code: 'ROLE_GLOBAL', reason: '역할 보유 (global)' };
    }
    if (scope === 'owned' && resource && resource.ownerId === subject.id) {
      return { allow: true, step: 3, code: 'ROLE_OWNED', reason: '역할 보유 (owned, 소유자 일치)' };
    }

    // 4. 리소스 Grant 허용 (만료되지 않은 ALLOW)
    if (resource && valid.some((g) => g.effect === 'ALLOW')) {
      return { allow: true, step: 4, code: 'GRANT', reason: 'ALLOW Grant' };
    }

    // 5. Default Deny (INV-5)
    return { allow: false, step: 5, code: 'DEFAULT_DENY', reason: '해당 규칙 없음 (default deny)' };
  }
}
