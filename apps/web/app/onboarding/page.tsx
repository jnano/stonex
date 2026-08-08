'use client';

import { useState } from 'react';
import { ApiError, endpoints } from '../../lib/api';
import { useSession } from '../../lib/session';

/**
 * 온보딩 화면 (§8.5).
 *
 * 온보딩 미완료 세션은 **온보딩 경로만** 접근할 수 있다. 로그인은 됐는데 아무 화면도 열리지
 * 않는 상태가 정상 동작이므로, 남은 항목을 여기서 끝내야 나머지 앱이 열린다.
 *
 * 최초 SUPER_ADMIN 시드와 `requires_2fa` 역할을 새로 받은 계정이 같은 게이트를 지난다.
 */
export default function OnboardingPage() {
  const { phase, onboarding, refresh, logout } = useSession();
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [keyUri, setKeyUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (phase === 'loading') return <main style={styles.page}>불러오는 중…</main>;
  if (phase === 'anonymous') {
    return (
      <main style={styles.page}>
        <p>세션이 만료되었습니다.</p>
        <a href="/">로그인 화면으로</a>
      </main>
    );
  }
  if (phase === 'ready' || !onboarding) {
    return (
      <main style={styles.page}>
        <p>온보딩이 완료되었습니다.</p>
        <a href="/">관리자 홈으로</a>
      </main>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '요청에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== password2) {
      setError('비밀번호가 서로 다릅니다.');
      return;
    }
    void run(async () => {
      await endpoints.onboardPassword(password);
      setPassword('');
      setPassword2('');
      await refresh();
    });
  };

  const beginTotp = () =>
    run(async () => {
      const { keyUri: uri } = await endpoints.onboardTotpBegin();
      setKeyUri(uri);
    });

  const confirmTotp = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await endpoints.onboardTotpConfirm(code);
      setCode('');
      setKeyUri(null);
      await refresh();
    });
  };

  const secret = keyUri ? (new URL(keyUri).searchParams.get('secret') ?? '') : '';

  return (
    <main style={styles.page}>
      <h1 style={{ marginTop: 0 }}>계정 설정 마무리</h1>
      <p style={styles.muted}>
        아래 항목을 마쳐야 관리 화면이 열립니다. 로그인 자체는 이미 성공한 상태입니다.
      </p>

      {error && <p style={styles.error}>{error}</p>}

      <section style={styles.card}>
        <h2 style={styles.h2}>
          1. 비밀번호 변경 {onboarding.mustChangePassword ? <span style={styles.todo}>필요</span> : <span style={styles.done}>완료</span>}
        </h2>
        {onboarding.mustChangePassword ? (
          <form onSubmit={submitPassword} style={styles.form}>
            <input
              type="password" placeholder="새 비밀번호" value={password} required minLength={12}
              onChange={(e) => setPassword(e.target.value)} style={styles.input}
            />
            <input
              type="password" placeholder="새 비밀번호 확인" value={password2} required
              onChange={(e) => setPassword2(e.target.value)} style={styles.input}
            />
            <button type="submit" disabled={busy} style={styles.button}>
              {busy ? '처리 중…' : '비밀번호 변경'}
            </button>
          </form>
        ) : (
          <p style={styles.muted}>변경을 마쳤습니다.</p>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>
          2. 2차 인증(TOTP) 등록 {onboarding.totpEnrollmentRequired ? <span style={styles.todo}>필요</span> : <span style={styles.done}>완료</span>}
        </h2>
        {onboarding.totpEnrollmentRequired ? (
          <>
            {!keyUri ? (
              <button onClick={() => void beginTotp()} disabled={busy} style={styles.button}>
                {busy ? '발급 중…' : '등록 시작'}
              </button>
            ) : (
              <>
                <p style={styles.muted}>
                  인증 앱에 아래 키를 등록한 뒤, 앱에 표시되는 6자리 코드를 입력하세요.
                </p>
                {/* 시크릿은 등록 진행 중인 본인에게만 잠시 노출된다 — 확인 후 화면에서 사라진다 */}
                <code style={styles.secret}>{secret}</code>
                <details style={{ margin: '8px 0' }}>
                  <summary style={styles.muted}>otpauth URI 전체 보기</summary>
                  <code style={{ ...styles.secret, fontSize: 12 }}>{keyUri}</code>
                </details>
                <form onSubmit={confirmTotp} style={styles.form}>
                  <input
                    inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="6자리 코드"
                    value={code} required onChange={(e) => setCode(e.target.value)} style={styles.input}
                  />
                  <button type="submit" disabled={busy} style={styles.button}>
                    {busy ? '확인 중…' : '등록 확인'}
                  </button>
                </form>
              </>
            )}
          </>
        ) : (
          <p style={styles.muted}>등록을 마쳤습니다.</p>
        )}
      </section>

      <button onClick={logout} style={{ ...styles.button, background: 'transparent' }}>로그아웃</button>
    </main>
  );
}

const styles = {
  page: { padding: 32, maxWidth: 560, margin: '0 auto', lineHeight: 1.6 },
  muted: { color: '#6b7280', fontSize: 14 },
  error: { color: '#b91c1c', background: '#fef2f2', padding: '8px 12px', borderRadius: 6 },
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, margin: '16px 0' },
  h2: { fontSize: 16, margin: '0 0 12px' },
  form: { display: 'grid', gap: 8 },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 },
  button: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
  secret: { display: 'block', background: '#f3f4f6', padding: '8px 10px', borderRadius: 6, wordBreak: 'break-all' as const },
  todo: { color: '#b45309', fontSize: 12, marginLeft: 6 },
  done: { color: '#047857', fontSize: 12, marginLeft: 6 },
};
