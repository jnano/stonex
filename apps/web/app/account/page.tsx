'use client';

import { useCallback, useEffect, useState } from 'react';
import { errorText, endpoints, type EmailChangeView } from '../../lib/api';
import { useSession } from '../../lib/session';

/**
 * 내 계정 — 이메일(로그인 식별자) 변경 (MEM-1).
 *
 * 화면이 두 단계를 그대로 드러낸다: **요청(재인증)** → **새 주소에서 확인**.
 * 확인 전까지 주소가 바뀌지 않는다는 사실을 화면에 적어 두는 이유는, 사용자가
 * "바뀐 줄 알고" 옛 주소로 로그인하지 못한다고 오해하는 일을 막기 위해서다.
 */
export default function AccountPage() {
  const { phase, me } = useSession();
  const [pending, setPending] = useState<EmailChangeView | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 변경 완료 — 이 상태에서는 세션이 이미 끊겼으므로 어떤 조회도 시도하지 않는다 */
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    setPending(await endpoints.emailChangePending());
  }, []);

  useEffect(() => {
    if (phase === 'ready' && !done) void load().catch(() => undefined);
  }, [phase, load, done]);

  // 변경을 마치면 세션이 끊긴 상태다. 다른 것을 더 보여주려 하면 실패만 쌓인다.
  if (done) {
    return (
      <main style={styles.page}>
        <h1>이메일이 변경되었습니다</h1>
        <p style={styles.muted}>
          보안을 위해 모든 세션이 종료되었습니다. <strong>새 이메일</strong>과 기존 비밀번호로
          다시 로그인하세요.
        </p>
        <p><a href="/">로그인 화면으로</a></p>
      </main>
    );
  }

  if (phase === 'loading') return <main style={styles.page}>불러오는 중…</main>;
  // 온보딩 미완료와 비로그인을 구분해 안내한다 — 둘을 묶으면 "로그인했는데 로그인하라"는
  // 화면이 나오고, 사용자는 무엇이 막혔는지 알 수 없다(§8.5).
  if (phase === 'onboarding') {
    return (
      <main style={styles.page}>
        <p>계정 설정을 먼저 마쳐야 합니다.</p>
        <a href="/onboarding">설정 마무리하러 가기</a>
      </main>
    );
  }
  if (phase !== 'ready') {
    return (
      <main style={styles.page}>
        <p>로그인이 필요합니다.</p>
        <a href="/">로그인 화면으로</a>
      </main>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e, '요청에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const submitRequest = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await endpoints.requestEmailChange(newEmail, {
        password: password || undefined,
        code: code || undefined,
      });
      setPassword('');
      setCode('');
      setMessage(`${newEmail} 로 확인 메일을 보냈습니다. 그 주소에서 확인해야 변경됩니다.`);
      setNewEmail('');
      await load();
    });
  };

  const submitConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await endpoints.confirmEmailChange(token);
      setToken('');
      setPending(null);
      setDone(true);
      // **여기서 목록을 다시 부르지 않는다.** 확인과 동시에 모든 세션이 폐기되므로(설계대로)
      // 후속 조회는 반드시 실패하고, 그 실패가 방금의 성공을 덮어써 "요청에 실패했습니다"를
      // 띄운다. 성공 처리와 후속 조회를 한 try 에 묶은 것이 원인이었다.
    });
  };

  const cancel = (id: string) =>
    run(async () => {
      await endpoints.cancelEmailChange(id);
      setMessage('요청을 취소했습니다.');
      await load();
    });

  return (
    <main style={styles.page}>
      <p><a href="/">← 관리자 홈</a></p>
      <h1 style={{ marginTop: 0 }}>내 계정</h1>

      {error && <p style={styles.error}>{error}</p>}
      {message && <p style={styles.notice}>{message}</p>}

      <section style={styles.card}>
        <h2 style={styles.h2}>이메일(로그인 아이디) 변경</h2>
        <p style={styles.muted}>
          현재 권한 {me?.permissions.length ?? 0}종 · 역할 {me?.roles.join(', ') || '없음'}
        </p>
        <p style={styles.muted}>
          <strong>확인을 마치기 전까지 주소는 바뀌지 않습니다.</strong> 새 주소로 보낸 확인 토큰을
          입력해야 교체되며, 교체 시 모든 세션이 종료됩니다.
        </p>

        {pending ? (
          <div style={styles.pendingBox}>
            <p style={{ margin: 0 }}>
              진행 중: <strong>{pending.newEmail}</strong>
            </p>
            <p style={styles.muted}>
              만료 {new Date(pending.expiresAt).toLocaleString('ko-KR')}
            </p>
            <button onClick={() => void cancel(pending.id)} disabled={busy} style={styles.button}>
              요청 취소
            </button>
          </div>
        ) : (
          <form onSubmit={submitRequest} style={styles.form}>
            <input
              type="email" placeholder="새 이메일" value={newEmail} required
              onChange={(e) => setNewEmail(e.target.value)} style={styles.input}
            />
            <p style={styles.muted}>
              본인 확인을 위해 아래 중 하나를 입력하세요 (§6.2 — 이메일 변경 시 재인증).
            </p>
            <input
              type="password" placeholder="현재 비밀번호" value={password}
              onChange={(e) => setPassword(e.target.value)} style={styles.input}
            />
            <input
              inputMode="numeric" maxLength={6} placeholder="또는 인증 앱 6자리 코드" value={code}
              onChange={(e) => setCode(e.target.value)} style={styles.input}
            />
            <button type="submit" disabled={busy} style={styles.button}>
              {busy ? '요청 중…' : '변경 요청'}
            </button>
          </form>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>확인 토큰 입력</h2>
        <p style={styles.muted}>
          새 주소로 받은 토큰을 붙여 넣으세요. 개발 환경에서는 메일이 실제로 발송되지 않으며,
          <code>DEV_MAIL_LOG_BODY=1</code> 로 API 서버를 띄운 경우에만 서버 로그에서 확인할 수 있습니다.
        </p>
        <form onSubmit={submitConfirm} style={styles.form}>
          <input
            placeholder="확인 토큰" value={token} required
            onChange={(e) => setToken(e.target.value)} style={styles.input}
          />
          <button type="submit" disabled={busy} style={styles.button}>
            {busy ? '확인 중…' : '변경 확인'}
          </button>
        </form>
      </section>
    </main>
  );
}

const styles = {
  page: { padding: 32, maxWidth: 560, margin: '0 auto', lineHeight: 1.6 },
  muted: { color: '#6b7280', fontSize: 14 },
  error: { color: '#b91c1c', background: '#fef2f2', padding: '8px 12px', borderRadius: 6 },
  notice: { color: '#065f46', background: '#ecfdf5', padding: '8px 12px', borderRadius: 6 },
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, margin: '16px 0' },
  pendingBox: { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: 12 },
  h2: { fontSize: 16, margin: '0 0 12px' },
  form: { display: 'grid', gap: 8 },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 },
  button: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
};
