'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  endpoints,
  type DomainSummary,
  type ShareSummary,
  type TransferSummary,
  type VerificationAttempt,
} from '../../../lib/api';
import { Banner, Card, Empty, Shell, s } from '../../../lib/ui';

/**
 * 도메인 관리 (DOM-1~7).
 *
 * 검증은 **비동기 잡**이라 요청 즉시 결과가 나오지 않는다(202). 화면이 "검증 중"을 그대로
 * 보여주고 이력을 따로 두는 이유다 — 동기 응답처럼 그리면 사용자가 실패로 오해한다.
 */
export default function DomainsPage() {
  const [items, setItems] = useState<DomainSummary[]>([]);
  const [selected, setSelected] = useState<DomainSummary | null>(null);
  const [attempts, setAttempts] = useState<VerificationAttempt[]>([]);
  const [delegations, setDelegations] = useState<ShareSummary[]>([]);
  const [transfers, setTransfers] = useState<TransferSummary[]>([]);
  const [newFqdn, setNewFqdn] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [perms, setPerms] = useState<string[]>(['domain.update']);
  const [toUserId, setToUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, mine] = await Promise.all([endpoints.domains(), endpoints.myTransfers()]);
    setItems(list.items);
    setTransfers(mine);
  }, []);

  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} (${e.status})` : '요청에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const select = (d: DomainSummary) =>
    run(async () => {
      setSelected(d);
      const [hist, dels] = await Promise.all([
        endpoints.verificationHistory(d.id).catch(() => []),
        endpoints.delegations(d.id).catch(() => []),
      ]);
      setAttempts(hist);
      setDelegations(dels);
    });

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const created = await endpoints.createDomain(newFqdn);
      setNewFqdn('');
      await load();
      setMessage(`등록했습니다: ${created.fqdn} (정규형으로 저장됩니다)`);
    });
  };

  const verify = (id: string) =>
    run(async () => {
      const { state } = await endpoints.verifyDomain(id);
      setAttempts(await endpoints.verificationHistory(id));
      setMessage(`검증을 요청했습니다 (${state}). DNS 조회는 백그라운드에서 진행됩니다.`);
    });

  const refreshSelected = async (id: string) => {
    setAttempts(await endpoints.verificationHistory(id));
    const list = await endpoints.domains();
    setItems(list.items);
    setSelected(list.items.find((d) => d.id === id) ?? null);
  };

  const delegate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    void run(async () => {
      const next = await endpoints.createDelegation(selected.id, subjectId, perms);
      setDelegations(next);
      setSubjectId('');
      setMessage('위임했습니다. domain.read 는 항상 함께 부여됩니다.');
    });
  };

  const propose = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    void run(async () => {
      await endpoints.proposeTransfer(selected.id, toUserId);
      setToUserId('');
      setTransfers(await endpoints.myTransfers());
      setMessage('이전을 발의했습니다. 수령자가 수락해야 소유권이 넘어갑니다.');
    });
  };

  const accept = (id: string) =>
    run(async () => {
      await endpoints.acceptTransfer(id);
      await load();
      setMessage('이전을 수락했습니다.');
    });

  return (
    <Shell title="도메인">
      <Banner error={error} message={message} />

      <Card title="도메인 등록">
        <form onSubmit={create} style={s.form}>
          <input
            placeholder="example.com" value={newFqdn} required
            onChange={(e) => setNewFqdn(e.target.value)} style={s.input}
          />
          <button type="submit" style={s.button} disabled={busy}>등록</button>
        </form>
        <p style={s.muted}>
          대소문자·후행 점·한글 도메인은 정규형(소문자·punycode)으로 변환되어 저장됩니다.
          등록에는 <code>domain.create</code>(global) 권한이 필요합니다.
        </p>
      </Card>

      <Card title="내 도메인">
        {items.length === 0 ? (
          <Empty>도메인이 없습니다.</Empty>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>FQDN</th>
                <th style={s.th}>상태</th>
                <th style={s.th}>관계</th>
                <th style={s.th}>검증</th>
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td style={s.td}>{d.fqdn}</td>
                  <td style={s.td}><span style={s.tag}>{d.status}</span></td>
                  <td style={s.td}>
                    <span style={s.tag}>{d.relation === 'owner' ? '소유' : '위임받음'}</span>
                  </td>
                  <td style={s.td}>
                    {d.verifiedAt ? new Date(d.verifiedAt).toLocaleDateString('ko-KR') : '—'}
                  </td>
                  <td style={s.td}>
                    <div style={s.row}>
                      <button onClick={() => void select(d)} style={s.button} disabled={busy}>관리</button>
                      {!d.verifiedAt && (
                        <button onClick={() => void verify(d.id)} style={s.button} disabled={busy}>
                          검증 요청
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {transfers.length > 0 && (
        <Card title="이전 발의">
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>도메인</th>
                <th style={s.th}>상태</th>
                <th style={s.th}>만료</th>
                <th style={s.th}>사유</th>
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td style={s.td}>{t.fqdn}</td>
                  <td style={s.td}><span style={s.tag}>{t.status}</span></td>
                  <td style={s.td}>{new Date(t.expiresAt).toLocaleString('ko-KR')}</td>
                  <td style={s.td}>{t.reason ?? '—'}</td>
                  <td style={s.td}>
                    {t.status === 'PENDING' && (
                      <button onClick={() => void accept(t.id)} style={s.button} disabled={busy}>
                        수락
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={s.muted}>
            수락은 수령자 본인만 할 수 있습니다. 수락 시점에 도메인 상태·발의자 소유권·만료를
            다시 확인하며, 하나라도 어긋나면 발의가 무효 종료됩니다.
          </p>
        </Card>
      )}

      {selected && (
        <>
          <Card title={`소유권 검증 — ${selected.fqdn}`}>
            {selected.verificationRecord ? (
              <>
                <p style={s.muted}>아래 TXT 레코드를 DNS 에 등록한 뒤 검증을 요청하세요.</p>
                <code style={s.code}>{selected.verificationRecord.name}</code>
                <code style={s.code}>{selected.verificationRecord.value}</code>
              </>
            ) : (
              <Empty>검증이 완료되어 토큰이 폐기되었습니다(재사용 방지).</Empty>
            )}
            <div style={{ ...s.row, marginTop: 8 }}>
              <button onClick={() => void verify(selected.id)} style={s.button} disabled={busy}>
                검증 요청
              </button>
              <button onClick={() => void run(() => refreshSelected(selected.id))} style={s.button} disabled={busy}>
                결과 새로고침
              </button>
            </div>
            {attempts.length > 0 && (
              <table style={{ ...s.table, marginTop: 12 }}>
                <thead>
                  <tr>
                    <th style={s.th}>시각</th>
                    <th style={s.th}>상태</th>
                    <th style={s.th}>사유</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.id}>
                      <td style={s.td}>{new Date(a.createdAt).toLocaleString('ko-KR')}</td>
                      <td style={s.td}><span style={s.tag}>{a.state}</span></td>
                      <td style={s.td}>{a.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="운영 위임">
            <form onSubmit={delegate} style={{ ...s.form, marginBottom: 12 }}>
              <input
                placeholder="수임자 사용자 ID (UUID)" value={subjectId} required
                onChange={(e) => setSubjectId(e.target.value)} style={s.input}
              />
              <div style={s.row}>
                {['domain.update', 'domain.verify'].map((code) => (
                  <label key={code} style={{ ...s.muted, display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input
                      type="checkbox" checked={perms.includes(code)}
                      onChange={(e) =>
                        setPerms((prev) =>
                          e.target.checked ? [...prev, code] : prev.filter((c) => c !== code),
                        )
                      }
                    />
                    {code}
                  </label>
                ))}
              </div>
              <button type="submit" style={s.button} disabled={busy}>위임</button>
            </form>
            <p style={s.muted}>
              <code>domain.read</code> 는 항상 함께 부여됩니다 — 없으면 수임자가 대상을 404 로 보면서
              수정만 가능한 운영 불능 상태가 됩니다. <code>domain.share</code>·<code>transfer</code>·
              <code>delete</code> 는 위임할 수 없습니다(재위임 전파 차단).
            </p>
            {delegations.length === 0 ? (
              <Empty>위임이 없습니다.</Empty>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>수임자</th>
                    <th style={s.th}>권한</th>
                    <th style={s.th} />
                  </tr>
                </thead>
                <tbody>
                  {delegations.map((d) => (
                    <tr key={d.grantId}>
                      <td style={s.td}>{d.subjectId}</td>
                      <td style={s.td}>{d.permission}</td>
                      <td style={s.td}>
                        <button
                          onClick={() =>
                            void run(async () => {
                              await endpoints.revokeDelegation(selected.id, d.grantId);
                              setDelegations(await endpoints.delegations(selected.id));
                              setMessage('위임을 회수했습니다.');
                            })
                          }
                          style={s.danger}
                          disabled={busy}
                        >
                          회수
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="소유자 이전">
            <form onSubmit={propose} style={s.form}>
              <input
                placeholder="수령자 사용자 ID (UUID)" value={toUserId} required
                onChange={(e) => setToUserId(e.target.value)} style={s.input}
              />
              <button type="submit" style={s.button} disabled={busy}>이전 발의</button>
            </form>
            <p style={s.muted}>
              발의만으로는 소유권이 넘어가지 않습니다. 수령자가 수락해야 하며, 수락 시
              <strong> ALLOW 위임은 모두 삭제되고 DENY 는 승계</strong>됩니다 —
              소유권 왕복만으로 제재가 풀리지 않게 하기 위해서입니다.
            </p>
          </Card>
        </>
      )}
    </Shell>
  );
}
