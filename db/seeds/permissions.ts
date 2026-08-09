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
  { code: 'member.create', scope: 'global', module: 'core', description: '회원 계정 생성(관리자 초대)' },
  { code: 'member.update', scope: 'global', module: 'core', description: '회원 정보 수정' },
  { code: 'member.role.assign', scope: 'global', module: 'core', description: '회원에게 역할 부여/회수' },
  { code: 'member.ban', scope: 'global', module: 'core', description: '회원 정지/해제' },
  { code: 'member.delete', scope: 'global', module: 'core', description: '회원 삭제(소프트 삭제)' },
  { code: 'file.upload', scope: 'global', module: 'core', description: '파일 업로드 (생성 행위, 대상 리소스 없음)' },
  { code: 'file.read', scope: 'owned', module: 'core', description: '소유 파일 조회·다운로드' },
  { code: 'file.update', scope: 'owned', module: 'core', description: '소유 파일 메타데이터 수정' },
  { code: 'file.delete', scope: 'owned', module: 'core', description: '소유 파일 삭제' },
  { code: 'file.share', scope: 'owned', module: 'core', description: '소유 파일 공유(Grant 생성/회수)' },
  { code: 'file.share.all', scope: 'global', module: 'core', description: '타인 파일 공유 생성·회수 (관리자용, 부여 범위는 file.read로 제한)' },
  { code: 'file.read.all', scope: 'global', module: 'core', description: '전체 파일 접근 (관리자용)' },
  { code: 'file.delete.all', scope: 'global', module: 'core', description: '전체 파일 삭제 (관리자용)' },
  { code: 'domain.create', scope: 'global', module: 'core', description: '도메인 등록 (생성 행위)' },
  { code: 'domain.read', scope: 'owned', module: 'core', description: '소유 도메인 조회' },
  { code: 'domain.update', scope: 'owned', module: 'core', description: '소유 도메인 설정 수정' },
  { code: 'domain.delete', scope: 'owned', module: 'core', description: '소유 도메인 삭제' },
  { code: 'domain.verify', scope: 'owned', module: 'core', description: '소유 도메인 소유권 검증 실행' },
  { code: 'domain.transfer', scope: 'owned', module: 'core', description: '소유 도메인 소유자 이전 발의' },
  { code: 'domain.share', scope: 'owned', module: 'core', description: '소유 도메인 운영 위임(Grant 생성/회수)' },
  { code: 'domain.share.all', scope: 'global', module: 'core', description: '타인 도메인 위임 회수 (관리자용 — 소유자 정지 시 유출 위임을 끊는 유일한 경로)' },
  { code: 'domain.read.all', scope: 'global', module: 'core', description: '전체 도메인 조회 (관리자용)' },
  { code: 'domain.update.all', scope: 'global', module: 'core', description: '전체 도메인 수정 (관리자용)' },
  { code: 'domain.delete.all', scope: 'global', module: 'core', description: '전체 도메인 삭제 (관리자용)' },
  { code: 'domain.verify.all', scope: 'global', module: 'core', description: '전체 도메인 검증 실행 (관리자용)' },
  { code: 'admin.role.read', scope: 'global', module: 'core', description: '역할·권한 정의 조회' },
  { code: 'admin.role.manage', scope: 'global', module: 'core', description: '역할 생성·수정·삭제, 역할-권한 매핑 편집' },
  { code: 'admin.audit.read', scope: 'global', module: 'core', description: '감사 로그 조회' },
  { code: 'governance.read', scope: 'global', module: 'core', description: '거버넌스 상태·활동 조회 (§14, RT-20)' },
  { code: 'governance.freeze.manage', scope: 'global', module: 'core', description: 'L-2 동결 해제 승인 (SUPER_ADMIN 전용)' },
  { code: 'system.settings.manage', scope: 'global', module: 'core', description: '시스템 설정 변경' },

  // ── board 모듈 기여 시작 (D-2 — 트랙 B 추출 시 이 블록이 모듈 시드 조각이 된다) ──
  { code: 'board.read', scope: 'global', module: 'board', description: '게시판·게시글·댓글 조회 (가시성은 §3.3 정책이 추가 판정)' },
  { code: 'board.write', scope: 'global', module: 'board', description: '게시글 작성' },
  { code: 'board.comment', scope: 'global', module: 'board', description: '댓글 작성' },
  { code: 'post.update', scope: 'owned', module: 'board', description: '자신의 게시글 수정' },
  { code: 'post.delete', scope: 'owned', module: 'board', description: '자신의 게시글 삭제' },
  { code: 'comment.update', scope: 'owned', module: 'board', description: '자신의 댓글 수정' },
  { code: 'comment.delete', scope: 'owned', module: 'board', description: '자신의 댓글 삭제' },
  { code: 'board.moderate', scope: 'owned', module: 'board', description: '게시판 운영 (게시판 단위 Grant 로 부여 — §3.3)' },
  { code: 'board.moderate.all', scope: 'global', module: 'board', description: '전체 게시판 운영 (플랫폼 운영자용)' },
  { code: 'post.delete.all', scope: 'global', module: 'board', description: '소유 무관 게시글 삭제 (플랫폼 관리자용)' },
  { code: 'comment.delete.all', scope: 'global', module: 'board', description: '소유 무관 댓글 삭제 (플랫폼 관리자용)' },
  { code: 'board.manage', scope: 'global', module: 'board', description: '게시판 생성·설정·타입·기능모듈 on/off·삭제' },
  // ── board 모듈 기여 끝 ──
];

/**
 * 리소스 타입별 Grant 가능 화이트리스트 (기획서 §4.4).
 * file.share는 재공유 전파 차단을 위해 의도적으로 제외(§10.1).
 * 소유자 이전(domain.transfer)·삭제는 Grant 위임 불가.
 */
export const GRANT_WHITELIST: Record<string, string[]> = {
  file: ['file.read', 'file.update'],
  domain: ['domain.read', 'domain.update', 'domain.verify'],
  // ── board 모듈 기여 (D-2): board.manage·*.all 은 제외 — 재위임·권한 환전 차단(스펙 §3.1) ──
  board: ['board.read', 'board.write', 'board.comment', 'board.moderate'],
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

/**
 * 역할 권한은 **하위 역할 집합에서 프로그램적으로 전개**한다 (기획서 §4.5, RI-9).
 *
 * 상위 역할의 권한을 손으로 나열하면, 하위 역할에 권한이 추가될 때 상위가 따라가지 못해
 * 우위 격자(SUPER_ADMIN ⊋ OPERATOR ⊋ {FILE_MANAGER, DOMAIN_MANAGER} ⊋ MEMBER)가 조용히 무너진다.
 * 격자가 깨지면 우위 검사(§4.6-1)가 INCOMPARABLE을 반환해 **상위 역할이 하위 회원을 관리할 수 없게 된다.**
 * 아래 전개 구조가 그 사고를 구조적으로 막고, G-4의 격자 검사가 이를 재확인한다.
 */
const MEMBER_PERMS = [
  // 파일: 자기 소유분
  'file.read', 'file.upload', 'file.update', 'file.delete', 'file.share',
  // 도메인: 자기 소유분 (등록 domain.create 는 global 이므로 DOMAIN_MANAGER 이상)
  'domain.read', 'domain.update', 'domain.verify', 'domain.delete', 'domain.transfer', 'domain.share',
];
// ── board 모듈 기여 (D-2): MEMBER 는 게시판 이용 전반 + 자기 글·댓글 관리(스펙 §3.2) ──
MEMBER_PERMS.push(
  'board.read', 'board.write', 'board.comment',
  'post.update', 'post.delete', 'comment.update', 'comment.delete',
);
const FILE_MANAGER_PERMS = [...MEMBER_PERMS, 'file.read.all', 'file.delete.all'];
const DOMAIN_MANAGER_PERMS = [
  ...MEMBER_PERMS,
  'domain.create', 'domain.read.all', 'domain.update.all', 'domain.delete.all', 'domain.verify.all',
];
const OPERATOR_PERMS = [
  ...new Set([...FILE_MANAGER_PERMS, ...DOMAIN_MANAGER_PERMS]),
  'member.read', 'member.create', 'member.update', 'member.ban', 'member.role.assign', 'member.delete',
  'admin.audit.read', 'governance.read',
  // ── board 모듈 기여 (D-2): 운영자는 전 게시판 운영·타인 글/댓글 삭제. board.manage 는
  // SUPER_ADMIN 전용(생성·삭제는 최고 권한 — 스펙 §3.2, 격자는 '*' 전개로 유지) ──
  'board.moderate.all', 'post.delete.all', 'comment.delete.all',
];

/**
 * 우위 격자 선언 — 상위 역할은 하위 역할의 **진상위 집합**이어야 한다.
 * G-4(governance/g4-seed-check.ts)가 이 선언을 실제 매핑과 대조한다.
 */
export const ROLE_LATTICE: Array<{ superior: string; inferior: string }> = [
  { superior: 'SUPER_ADMIN', inferior: 'OPERATOR' },
  { superior: 'OPERATOR', inferior: 'FILE_MANAGER' },
  { superior: 'OPERATOR', inferior: 'DOMAIN_MANAGER' },
  { superior: 'FILE_MANAGER', inferior: 'MEMBER' },
  { superior: 'DOMAIN_MANAGER', inferior: 'MEMBER' },
];

/** 기획서 §4.5 표와 1:1 — 5종. "보유분 +"는 여기서 개별 코드로 전개해 저장한다(역할 상속 없음) */
export const ROLES: RoleDef[] = [
  { code: 'MEMBER', name: '일반회원', displayOrder: 10, requires2fa: false, isSystem: true, permissions: MEMBER_PERMS },
  { code: 'FILE_MANAGER', name: '파일관리자', displayOrder: 30, requires2fa: false, isSystem: false, permissions: FILE_MANAGER_PERMS },
  { code: 'DOMAIN_MANAGER', name: '도메인관리자', displayOrder: 30, requires2fa: false, isSystem: false, permissions: DOMAIN_MANAGER_PERMS },
  { code: 'OPERATOR', name: '운영자', displayOrder: 60, requires2fa: true, isSystem: false, permissions: OPERATOR_PERMS },
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
