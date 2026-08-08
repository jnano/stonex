'use client';

import { useState } from 'react';
import { endpoints, setAccessToken } from '../lib/api';
import { useSession } from '../lib/session';
import { visibleNavItems } from '../lib/nav';

/** 로그인 + 진입 화면. 실패 사유는 서버가 구분해 주지 않는다(§10.2) */
export default function Home() {
  const { me, can, phase, loading, refresh, logout } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { accessToken } = await endpoints.login(email, password);
      setAccessToken(accessToken);
      await refresh();
    } catch {
      setError('로그인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <main style={{ padding: 32 }}>불러오는 중…</main>;

  // 로그인은 됐지만 온보딩이 남은 상태(§8.5). 이 분기가 없으면 /me 가 막히는 것을
  // "비로그인"으로 오인해 **로그인 화면으로 계속 되돌아간다.**
  if (phase === 'onboarding') {
    return (
      <main style={{ padding: 32, maxWidth: 480, margin: '0 auto' }}>
        <h1>계정 설정이 남아 있습니다</h1>
        <p style={{ color: '#6b7280' }}>
          로그인은 성공했습니다. 최초 접속 계정은 비밀번호 변경과 2차 인증 등록을 마쳐야
          관리 화면이 열립니다.
        </p>
        <p><a href="/onboarding">설정 마무리하러 가기</a></p>
        <button onClick={logout}>로그아웃</button>
      </main>
    );
  }

  if (me) {
    return (
      <main style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
        <h1>stonex 관리자</h1>
        <p>
          상태: {me.status} · 역할: {me.roles.join(', ') || '없음'} · 권한 {me.permissions.length}종
        </p>
        {/* 링크 목록은 Shell 과 같은 단일 출처(lib/nav.ts) — 레이아웃만 다르다 */}
        <nav style={{ display: 'flex', gap: 12, margin: '16px 0', flexWrap: 'wrap' }}>
          {visibleNavItems(can).map((item) => (
            <a key={item.href} href={item.href}>{item.label}</a>
          ))}
        </nav>
        <button onClick={logout}>로그아웃</button>
      </main>
    );
  }

  return (
    <main style={{ padding: 32, maxWidth: 360, margin: '0 auto' }}>
      <h1>로그인</h1>
      <form onSubmit={submit} style={{ display: 'grid', gap: 8 }}>
        <input
          type="email" placeholder="이메일" value={email} required
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password" placeholder="비밀번호" value={password} required
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy}>{busy ? '확인 중…' : '로그인'}</button>
      </form>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </main>
  );
}
