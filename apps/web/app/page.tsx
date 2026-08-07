'use client';

import { useState } from 'react';
import { endpoints, setAccessToken } from '../lib/api';
import { useSession } from '../lib/session';

/** 로그인 + 진입 화면. 실패 사유는 서버가 구분해 주지 않는다(§10.2) */
export default function Home() {
  const { me, loading, refresh, logout } = useSession();
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

  if (me) {
    return (
      <main style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
        <h1>stonex 관리자</h1>
        <p>
          상태: {me.status} · 역할: {me.roles.join(', ') || '없음'} · 권한 {me.permissions.length}종
        </p>
        <nav style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
          <a href="/admin/members">회원 관리</a>
          <a href="/admin/roles">역할 관리</a>
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
