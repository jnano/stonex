/**
 * Permission·역할 정의의 유일한 출처 (기획서 §4.4·§4.5, §10.3, §16.2).
 * - 관리 콘솔에서 Permission 생성 불가 — 본 파일 + 마이그레이션으로만 변경한다.
 * - 와일드카드(`file.*`)는 정의 편의 문법이며 expandWildcards()로 개별 코드로 전개 후 저장한다(§4.2).
 * - G-4(governance/g4-seed-check.ts)가 본 정의의 정합성을 CI에서 검사한다.
 */

export type PermissionScope = 'global' | 'owned';

export interface PermissionDef {
  code: string;
  scope: PermissionScope;
  module: string;
  description: string;
}

/** 기획서 §4.4 표와 1:1 — 26종 */
export const PERMISSIONS: PermissionDef[] = [
  { code: 'member.read', scope: 'global', module: 'core', description: '회원 목록·상세 조회' },
  { code: 'member.update', scope: 'global', module: 'core', description: '회원 정보 수정' },
  { code: 'member.role.assign', scope: 'global', module: 'core', description: '회원에게 역할 부여/회수' },
  { code: 'member.ban', scope: 'global', module: 'core', description: '회원 정지/해제' },
  { code: 'member.delete', scope: 'global', module: 'core', description: '회원 삭제(소프트 삭제)' },
  { code: 'file.upload', scope: 'global', module: 'core', description: '파일 업로드 (생성 행위, 대상 리소스 없음)' },
  { code: 'file.read', scope: 'owned', module: 'core', description: '소유 파일 조회·다운로드' },
  { code: 'file.update', scope: 'owned', module: 'core', description: '소유 파일 메타데이터 수정' },
  { code: 'file.delete', scope: 'owned', module: 'core', description: '소유 파일 삭제' },
  { code: 'file.share', scope: 'owned', module: 'core', description: '소유 파일 공유(Grant 생성/회수)' },
  { code: 'file.read.all', scope: 'global', module: 'core', description: '전체 파일 접근 (관리자용)' },
  { code: 'file.delete.all', scope: 'global', module: 'core', description: '전체 파일 삭제 (관리자용)' },
  { code: 'domain.create', scope: 'global', module: 'core', description: '도메인 등록 (생성 행위)' },
  { code: 'domain.read', scope: 'owned', module: 'core', description: '소유 도메인 조회' },
  { code: 'domain.update', scope: 'owned', module: 'core', description: '소유 도메인 설정 수정' },
  { code: 'domain.delete', scope: 'owned', module: 'core', description: '소유 도메인 삭제' },
  { code: 'domain.verify', scope: 'owned', module: 'core', description: '소유 도메인 소유권 검증 실행' },
  { code: 'domain.transfer', scope: 'owned', module: 'core', description: '소유 도메인 소유자 이전 발의' },
  { code: 'domain.read.all', scope: 'global', module: 'core', description: '전체 도메인 조회 (관리자용)' },
  { code: 'domain.update.all', scope: 'global', module: 'core', description: '전체 도메인 수정 (관리자용)' },
  { code: 'domain.delete.all', scope: 'global', module: 'core', description: '전체 도메인 삭제 (관리자용)' },
  { code: 'domain.verify.all', scope: 'global', module: 'core', description: '전체 도메인 검증 실행 (관리자용)' },
  { code: 'admin.role.read', scope: 'global', module: 'core', description: '역할·권한 정의 조회' },
  { code: 'admin.role.manage', scope: 'global', module: 'core', description: '역할 생성·수정·삭제, 역할-권한 매핑 편집' },
  { code: 'admin.audit.read', scope: 'global', module: 'core', description: '감사 로그 조회' },
  { code: 'system.settings.manage', scope: 'global', module: 'core', description: '시스템 설정 변경' },
  { code: 'File.Read', scope: 'owned', module: '', description: '' }, // G-4 실증용 위반: 대문자·module 누락
];

/**
 * 리소스 타입별 Grant 가능 화이트리스트 (기획서 §4.4).
 * file.share는 재공유 전파 차단을 위해 의도적으로 제외(§10.1).
 * 소유자 이전(domain.transfer)·삭제는 Grant 위임 불가.
 */
export const GRANT_WHITELIST: Record<string, string[]> = {
  file: ['file.read', 'file.update'],
  domain: ['domain.read', 'domain.update', 'domain.verify'],
};

export interface RoleDef {
  code: string;
  name: string;
  displayOrder: number; // 정렬·표시 전용 (INV-2)
  requires2fa: boolean; // §10.4 — 보유 계정에 2FA 강제 (RT-11)
  isSystem: boolean;
  /** 보유 Permission 코드. 'file.*' 와일드카드 허용(저장 전 전개) */
  permissions: string[];
}

const MEMBER_PERMS = ['file.read', 'file.upload', 'file.update', 'file.delete', 'file.share', 'domain.read'];
const FILE_MANAGER_PERMS = [...MEMBER_PERMS, 'file.read.all', 'file.delete.all'];
const DOMAIN_MANAGER_PERMS = [
  ...MEMBER_PERMS,
  'domain.create', 'domain.read.all', 'domain.update.all', 'domain.delete.all', 'domain.verify.all',
];

/** 기획서 §4.5 표와 1:1 — 5종. "보유분 +"는 여기서 개별 코드로 전개해 저장한다(역할 상속 없음) */
export const ROLES: RoleDef[] = [
  { code: 'MEMBER', name: '일반회원', displayOrder: 10, requires2fa: false, isSystem: true, permissions: MEMBER_PERMS },
  { code: 'FILE_MANAGER', name: '파일관리자', displayOrder: 30, requires2fa: false, isSystem: false, permissions: FILE_MANAGER_PERMS },
  { code: 'DOMAIN_MANAGER', name: '도메인관리자', displayOrder: 30, requires2fa: false, isSystem: false, permissions: DOMAIN_MANAGER_PERMS },
  {
    code: 'OPERATOR', name: '운영자', displayOrder: 60, requires2fa: true, isSystem: false,
    permissions: [
      ...new Set([...FILE_MANAGER_PERMS, ...DOMAIN_MANAGER_PERMS]),
      'member.read', 'member.update', 'member.ban', 'member.role.assign', 'member.delete',
      'admin.audit.read',
    ],
  },
  { code: 'SUPER_ADMIN', name: '최고관리자', displayOrder: 100, requires2fa: true, isSystem: true, permissions: ['*'] },
];

/** 기본 테넌트 고정 UUID (기획서 §5.2) */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * 와일드카드 전개(§4.2): '*' → 전체, '{prefix}.*' → 해당 접두 코드 전체.
 * 런타임 평가기에는 와일드카드가 도달하지 않는다 — 저장 전 전개가 유일한 사용처.
 */
export function expandWildcards(codes: string[], all: PermissionDef[] = PERMISSIONS): string[] {
  const expanded = codes.flatMap((code) => {
    if (code === '*') return all.map((p) => p.code);
    if (code.endsWith('.*')) {
      const prefix = code.slice(0, -1); // 'file.*' → 'file.'
      return all.filter((p) => p.code.startsWith(prefix)).map((p) => p.code);
    }
    return [code];
  });
  return [...new Set(expanded)];
}
