import { SetMetadata } from '@nestjs/common';

export const PERMISSION_META = 'authz:permission';
export const PUBLIC_META = 'authz:public';
export const DOMINANCE_META = 'authz:dominance';

export interface RequirePermissionOptions {
  /** 리소스형 API: 평가 전 리소스를 1회 로드한다 (§4.7 이중 조회 방지) */
  resource?: { type: string; param: string };
}

export interface PermissionRequirement extends RequirePermissionOptions {
  code: string;
}

/**
 * 엔드포인트 권한 선언 (기획서 §7.3).
 * 모든 엔드포인트는 @RequirePermission 또는 @Public 중 하나를 반드시 선언해야 하며,
 * 미선언 엔드포인트는 서버 기동이 실패한다(INV-5 구현 장치 — startup-check.ts).
 *
 * 예: @RequirePermission('file.delete', { resource: { type: 'file', param: 'id' } })
 */
export const RequirePermission = (code: string, options: RequirePermissionOptions = {}) =>
  SetMetadata(PERMISSION_META, { code, ...options } satisfies PermissionRequirement);

/** 인증 불요 공개 엔드포인트 명시 (§7.3). 암묵적 공개는 존재하지 않는다 */
export const Public = () => SetMetadata(PUBLIC_META, true);

/**
 * 관리 행위 선언: Permission 통과에 더해 우위 검사(§4.6-1)를 요구한다.
 * targetParam 경로 파라미터의 사용자가 대상이 된다. WP-5의 MEM-3~6 라우트에 부착.
 */
export const RequireDominance = (targetParam = 'id') => SetMetadata(DOMINANCE_META, { targetParam });
