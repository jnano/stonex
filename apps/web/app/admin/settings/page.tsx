'use client';

import { useCallback, useEffect, useState } from 'react';
import { endpoints, errorText, type CategoryView, type TestResult } from '../../../lib/api';
import { Banner, Card, Shell, s, statusStyle } from '../../../lib/ui';

/**
 * 시스템 설정 (범용 배포 지원).
 *
 * **비밀값은 서버가 내려주지 않는다.** 화면은 "설정됨" 여부만 받고, 바꿀 때만 새 값을 보낸다.
 * 그래서 비밀 칸을 비워 두고 저장하면 "변경 없음"으로 처리된다 — 그렇지 않으면 호스트 하나
 * 고칠 때마다 비밀번호가 지워진다.
 *
 * 폼은 서버가 내려주는 항목 정의로 그린다. 새 설정이 늘어도 이 화면을 고칠 필요가 없다(§15.1).
 */
export default function SettingsPage() {
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [keyReady, setKeyReady] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await endpoints.settings();
    setCategories(res.categories);
    setKeyReady(res.encryptionKeyConfigured);
    // 평문 값만 초기값으로 채운다. 비밀 항목은 언제나 빈 칸에서 시작한다.
    const next: Record<string, Record<string, string>> = {};
    for (const cat of res.categories) {
      next[cat.category] = Object.fromEntries(
        cat.fields.map((f) => [f.key, f.kind === 'secret' ? '' : (f.value ?? '')]),
      );
    }
    setDrafts(next);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(errorText(e)));
  }, [load]);

  const setField = (category: string, key: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [category]: { ...prev[category], [key]: value } }));

  const save = (category: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void (async () => {
      try {
        await endpoints.updateSettings(category, drafts[category] ?? {});
        await load();
        setMessage('저장했습니다. 재기동 없이 바로 반영됩니다.');
      } catch (e) {
        setError(errorText(e, '저장에 실패했습니다.'));
      } finally {
        setBusy(false);
      }
    })();
  };

  const test = (category: string) => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const result = await endpoints.testSettings(category);
        setTests((prev) => ({ ...prev, [category]: result }));
      } catch (e) {
        setTests((prev) => ({ ...prev, [category]: { ok: false, message: errorText(e) } }));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Shell title="시스템 설정">
      <Banner error={error} message={message} />

      {!keyReady && (
        <p style={s.error}>
          <strong>SETTINGS_ENCRYPTION_KEY 가 설정되지 않았습니다.</strong> 비밀 항목을 저장할 수
          없습니다. <code>openssl rand -base64 32</code> 로 만들어 환경 변수로 주입한 뒤 재기동하십시오.
        </p>
      )}

      <p style={s.muted}>
        접속 정보는 여기서 관리합니다. 환경 변수로 남는 것은 <code>DATABASE_URL</code>,{' '}
        <code>SETTINGS_ENCRYPTION_KEY</code>, <code>JWT_SECRET</code> 세 개뿐입니다 —
        DB 주소를 DB 에 둘 수 없고, 비밀값을 푸는 열쇠를 같은 DB 에 두면 자물쇠 옆에 열쇠를
        두는 셈이기 때문입니다.
      </p>

      {categories.map((cat) => {
        const result = tests[cat.category];
        return (
          <Card key={cat.category} title={cat.label}>
            <p style={s.muted}>{cat.description}</p>

            <div style={{ display: 'grid', gap: 10, maxWidth: 560, margin: '12px 0' }}>
              {cat.fields.map((f) => (
                <label key={f.key} style={{ display: 'grid', gap: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {f.label}
                    {f.required && <span style={{ color: '#b91c1c' }}> *</span>}
                    {f.kind === 'secret' && (
                      <span style={{ ...statusStyle(f.configured ? 'ok' : 'unknown'), marginLeft: 6 }}>
                        {f.configured ? '설정됨' : '미설정'}
                      </span>
                    )}
                  </span>

                  {f.kind === 'select' ? (
                    <select
                      value={drafts[cat.category]?.[f.key] ?? ''}
                      onChange={(e) => setField(cat.category, f.key, e.target.value)}
                      style={s.input}
                    >
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'text' : 'text'}
                      inputMode={f.kind === 'number' ? 'numeric' : undefined}
                      value={drafts[cat.category]?.[f.key] ?? ''}
                      placeholder={f.kind === 'secret' && f.configured ? '변경할 때만 입력' : f.placeholder}
                      onChange={(e) => setField(cat.category, f.key, e.target.value)}
                      style={s.input}
                      autoComplete="off"
                    />
                  )}

                  {f.hint && <span style={{ ...s.muted, fontSize: 12 }}>{f.hint}</span>}
                </label>
              ))}
            </div>

            <div style={s.row}>
              <button onClick={() => save(cat.category)} disabled={busy} style={s.button}>
                저장
              </button>
              {cat.testable && (
                <button onClick={() => test(cat.category)} disabled={busy} style={s.button}>
                  연결 테스트
                </button>
              )}
              {result && (
                <span style={statusStyle(result.ok ? 'ok' : 'failed')}>
                  {result.ok ? '성공' : '실패'} · {result.message}
                </span>
              )}
            </div>

            <p style={{ ...s.muted, marginTop: 8 }}>
              연결 테스트는 <strong>저장된 설정</strong>으로 시도합니다. 값을 고쳤다면 먼저 저장하세요.
            </p>
          </Card>
        );
      })}
    </Shell>
  );
}
