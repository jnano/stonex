import { Inject, Injectable } from '@nestjs/common';
import { ResourceTypeRegistry } from './resource-registry';
import { Decision, GrantStore, ResourceRef, SubjectSnapshot } from './types';

export const GRANT_STORE = Symbol('GRANT_STORE');

/**
 * 권한 평가기 (기획서 §4.7). 모든 권한 검사는 이 단일 함수를 통과한다(INV-1).
 * 평가 순서는 §4.7 그대로이며, 각 단계에서 결정되면 즉시 종료한다.
 * 프론트엔드·핸들러가 이 로직을 중복 구현하는 것을 금지한다.
 *
 * 리소스 타입별 상태 게이트는 레지스트리의 서술자가 정한다(WP-K1) — 이 파일은
 * 어떤 타입이 존재하는지 모르고, 미등록 타입은 1단계에서 접근 불가로 떨어진다.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(GRANT_STORE) private readonly grants: GrantStore,
    private readonly registry: ResourceTypeRegistry,
  ) {}

  async can(subject: SubjectSnapshot, permission: string, resource?: ResourceRef): Promise<Decision> {
    // 0. 주체 상태 검사 — 정지·탈퇴·미인증 계정 전면 차단
    if (subject.status !== 'ACTIVE') {
      return { allow: false, step: 0, code: 'SUBJECT_NOT_ACTIVE', reason: `주체 상태 ${subject.status}` };
    }

    // 1. 리소스 상태 검사 (소프트 삭제·정지 리소스의 소유자/전역 경로 접근 차단)
    if (resource) {
      const gate = this.registry.get(resource.type)?.stateGate;
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
