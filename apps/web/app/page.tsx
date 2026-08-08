'use client';

import { useState } from 'react';
import { DEV_LOGIN_ENABLED, endpoints, setAccessToken } from '../lib/api';
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

  /** 개발 전용 — 비밀번호 없이 시드 계정으로 들어간다. 실제 토큰을 받으므로
   *  이후 화면 동작은 운영과 같다(우회되는 건 비밀번호 확인 한 단계뿐) */
  const devLogin = (target: string) => {
    setBusy(true);
    setError(null);
    void endpoints
      .devLogin(target)
      .then(({ accessToken }) => {
        setAccessToken(accessToken);
        return refresh();
      })
      .catch(() => setError('개발 로그인에 실패했습니다 — 서버에도 DEV_LOGIN=1 이 필요합니다.'))
      .finally(() => setBusy(false));
  };

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

      {DEV_LOGIN_ENABLED && (
        <div style={{ marginTop: 20, padding: 12, border: '1px dashed #f59e0b', borderRadius: 6 }}>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#92400e' }}>
            <strong>개발 전용</strong> — 배포 빌드에는 포함되지 않습니다.
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => devLogin('admin@stonex.local')} disabled={busy}>
              관리자로 로그인
            </button>
            <button
              type="button"
              onClick={() => { if (email.trim()) devLogin(email.trim()); }}
              disabled={busy || !email.trim()}
              title="위 이메일 칸의 계정으로 비밀번호 없이 로그인"
            >
              입력한 계정으로
            </button>
          </div>
        </div>
      )}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </main>
  );
}
