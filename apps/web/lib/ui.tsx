'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useSession } from './session';

/**
 * 관리자 콘솔 공통 껍데기.
 *
 * **네비게이션 항목은 `can()` 으로 감춘다 — 그러나 이는 UX 보조일 뿐이다.**
 * 링크를 숨겨도 주소를 직접 치면 화면은 열리고, 그때 실제 차단은 서버의 403/404 가 한다(§3, §8.4).
 * 프론트에서 권한 판단을 재구현하지 않는다는 규약이 여기서도 그대로 적용된다.
 */
export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const { me, can, logout, phase } = useSession();

  if (phase === 'loading') return <main style={s.page}>불러오는 중…</main>;
  if (phase === 'onboarding') {
    return (
      <main style={s.page}>
        <p>계정 설정을 먼저 마쳐야 합니다.</p>
        <a href="/onboarding">설정 마무리하러 가기</a>
      </main>
    );
  }
  if (phase !== 'ready') {
    return (
      <main style={s.page}>
        <p>로그인이 필요합니다.</p>
        <a href="/">로그인 화면으로</a>
      </main>
    );
  }

  const links: Array<{ href: string; label: string; show: boolean }> = [
    // ── board 모듈 기여 (D-2): 사용자 게시판 + 관리 링크 ──
    { href: '/board', label: '게시판', show: can('board.read') },
    { href: '/notifications', label: '알림', show: can('board.read') },
    { href: '/admin/board', label: '게시판 관리', show: can('board.manage') },
    // ── board 모듈 기여 끝 ──
    { href: '/admin/members', label: '회원', show: can('member.read') },
    { href: '/admin/roles', label: '역할', show: can('admin.role.read') },
    { href: '/admin/files', label: '파일', show: true },
    { href: '/admin/domains', label: '도메인', show: true },
    { href: '/admin/audit', label: '감사 로그', show: can('admin.audit.read') },
    { href: '/admin/simulator', label: '시뮬레이터', show: can('admin.role.read') },
    { href: '/admin/governance', label: '거버넌스', show: can('governance.read') },
    { href: '/admin/version', label: '버전', show: can('governance.read') },
    { href: '/admin/settings', label: '설정', show: can('system.settings.manage') },
    { href: '/account', label: '내 계정', show: true },
  ];

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={s.header}>
        <a href="/" style={{ ...s.brand, textDecoration: 'none' }}>stonex</a>
        <nav style={s.nav}>
          {links.filter((l) => l.show).map((l) => (
            <a key={l.href} href={l.href} style={s.navLink}>{l.label}</a>
          ))}
        </nav>
        <span style={s.who}>{me?.roles.join(', ') || '역할 없음'}</span>
        <button onClick={logout} style={s.logout}>로그아웃</button>
      </header>
      <main style={s.page}>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>{title}</h1>
        {children}
      </main>
    </div>
  );
}

/** 서버가 돌려준 실패를 그대로 보여준다 — 프론트가 사유를 지어내지 않는다 */
export function Banner({ error, message }: { error?: string | null; message?: string | null }) {
  return (
    <>
      {error && <p style={s.error}>{error}</p>}
      {message && <p style={s.notice}>{message}</p>}
    </>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section style={s.card}>
      {title && <h2 style={s.h2}>{title}</h2>}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p style={s.muted}>{children}</p>;
}

export const s: Record<string, CSSProperties> = {
  page: { padding: '24px 32px', maxWidth: 1080, margin: '0 auto', lineHeight: 1.6 },
  header: {
    display: 'flex', alignItems: 'center', gap: 16, padding: '10px 32px',
    background: '#fff', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap',
  },
  brand: { fontWeight: 700, color: '#111827' },
  nav: { display: 'flex', gap: 14, flex: 1, flexWrap: 'wrap' },
  navLink: { fontSize: 14, color: '#374151' },
  who: { fontSize: 12, color: '#6b7280' },
  logout: { padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  muted: { color: '#6b7280', fontSize: 14 },
  error: { color: '#b91c1c', background: '#fef2f2', padding: '8px 12px', borderRadius: 6 },
  notice: { color: '#065f46', background: '#ecfdf5', padding: '8px 12px', borderRadius: 6 },
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, margin: '16px 0' },
  h2: { fontSize: 15, margin: '0 0 12px' },
  form: { display: 'grid', gap: 8, maxWidth: 420 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  input: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 },
  button: { padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 14, background: '#fff' },
  danger: { padding: '4px 10px', border: '1px solid #fca5a5', color: '#b91c1c', borderRadius: 6, cursor: 'pointer', fontSize: 13, background: '#fff' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: { textAlign: 'left', padding: '8px 6px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151' },
  td: { padding: '8px 6px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' },
  code: { display: 'block', background: '#f3f4f6', padding: '8px 10px', borderRadius: 6, wordBreak: 'break-all', fontSize: 12 },
  // border 를 축약형으로 두면 statusStyle 이 borderColor 만 덮을 때 React 가
  // "축약형/개별 속성 혼용" 경고를 낸다(상태가 바뀌는 순찰·버전 화면에서 발생) —
  // 개별 속성으로 분해해 두고 색만 갈아끼운다
  tag: {
    fontSize: 12, padding: '1px 7px', borderRadius: 999,
    borderWidth: 1, borderStyle: 'solid', borderColor: '#d1d5db',
  },
};

/** 상태 색 — '검사 실패'와 '이상 없음'을 눈으로 구분하기 위한 것(RT-20) */
export function statusStyle(status: string): CSSProperties {
  switch (status) {
    case 'ok': return { ...s.tag, color: '#047857', borderColor: '#a7f3d0', background: '#ecfdf5' };
    case 'violated': return { ...s.tag, color: '#b45309', borderColor: '#fcd34d', background: '#fffbeb' };
    case 'failed': return { ...s.tag, color: '#b91c1c', borderColor: '#fca5a5', background: '#fef2f2' };
    default: return { ...s.tag, color: '#6b7280', borderColor: '#e5e7eb', background: '#f9fafb' };
  }
}
