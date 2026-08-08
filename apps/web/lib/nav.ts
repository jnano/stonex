/**
 * 내비게이션 항목 — **단일 출처** (§15.1).
 *
 * 홈 화면과 Shell 이 각자 링크 목록을 들고 있었고, 그래서 게시판 화면을 추가했을 때
 * 두 곳 모두를 고쳐야 하는 것을 몰라 한쪽만 빠졌다(PR #33·#35 가 같은 누락의 앞뒤).
 * 화면이 늘 때 고칠 곳을 하나로 만든다 — 레이아웃은 달라도 목록은 같다.
 *
 * `show` 는 `can()` 결과다. **표시 분기일 뿐 보안 경계가 아니다** — 링크를 숨겨도
 * 주소를 직접 치면 화면은 열리고, 실제 차단은 서버의 403/404 가 한다(§3·§8.4, G-2).
 */
export interface NavItem {
  href: string;
  label: string;
  /** 표시 조건이 되는 Permission 코드. 없으면 로그인만으로 표시 */
  permission?: string;
}

export const NAV_ITEMS: NavItem[] = [
  // ── board 모듈 기여 (D-2 — 트랙 B 추출 시 이 블록이 모듈 내비 조각이 된다) ──
  { href: '/board', label: '게시판', permission: 'board.read' },
  { href: '/notifications', label: '알림', permission: 'board.read' },
  { href: '/admin/board', label: '게시판 관리', permission: 'board.manage' },
  // ── board 모듈 기여 끝 ──
  { href: '/admin/members', label: '회원', permission: 'member.read' },
  { href: '/admin/roles', label: '역할', permission: 'admin.role.read' },
  { href: '/admin/files', label: '파일' },
  { href: '/admin/domains', label: '도메인' },
  { href: '/admin/audit', label: '감사 로그', permission: 'admin.audit.read' },
  { href: '/admin/simulator', label: '시뮬레이터', permission: 'admin.role.read' },
  { href: '/admin/governance', label: '거버넌스', permission: 'governance.read' },
  { href: '/admin/version', label: '버전', permission: 'governance.read' },
  { href: '/admin/settings', label: '설정', permission: 'system.settings.manage' },
  { href: '/account', label: '내 계정' },
];

/** 표시할 항목만 — can 은 useSession().can 을 그대로 넘긴다(권한 판단을 재구현하지 않는다) */
export function visibleNavItems(can: (code: string) => boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => item.permission === undefined || can(item.permission));
}
