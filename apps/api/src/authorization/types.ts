/** 권한 평가 관련 공용 타입 (기획서 §4.3·§4.7) */

export type PermissionScope = 'global' | 'owned';

/** 주체의 유효 권한 스냅샷. WP-3은 DB 직조회로 구성하고, WP-4에서 Redis 캐시가 같은 형태를 제공한다(§8.3) */
export interface SubjectSnapshot {
  id: string;
  tenantId: string;
  status: string; // ACTIVE | PENDING | SUSPENDED | DELETED
  permVersion: number;
  roles: string[]; // 역할 코드 (표시·감사용)
  permissions: ReadonlyMap<string, PermissionScope>; // code → scope
}

/** 평가 대상 리소스 참조. 리소스형 API는 핸들러 진입 전 1회 로드하여 평가기와 공유한다(§4.7) */
export interface ResourceRef {
  type: string; // 'file' | 'domain' | (§9.1 확장)
  id: string;
  ownerId: string;
  status: string;
  tenantId: string;
}

/** 평가 결과. step은 §4.7의 결정 단계 — 시뮬레이터(ADM-5)·존재 은닉 404(§10.2)가 사용한다 */
export interface Decision {
  allow: boolean;
  step: 0 | 1 | 2 | 3 | 4 | 5;
  reason: string; // 내부용 — API 응답에 노출 금지(§10.2)
}

/** Grant 조회 인터페이스 (평가기 2·4단계). Prisma 구현은 grant.store.ts */
export interface GrantStore {
  findGrants(
    subjectId: string,
    resourceType: string,
    resourceId: string,
    permissionCode: string,
  ): Promise<Array<{ effect: 'ALLOW' | 'DENY'; expiresAt: Date | null }>>;
}
