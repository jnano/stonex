'use client';

import { useState } from 'react';
import { errorText, endpoints, type AuditEntryView } from '../../../lib/api';
import { Banner, Card, Empty, Shell, s } from '../../../lib/ui';

/** 기본 조회 창 — 7일. 파티션 프루닝이 의미를 가지려면 창이 유한해야 한다 */
const DEFAULT_DAYS = 7;
const isoLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  .toISOString().slice(0, 16);

/**
 * ADM-4 감사 로그 조회.
 *
 * **기간이 필수 입력이다.** 서버가 기간 없는 조회를 거부하는데, 그 이유를 화면에도 적어 둔다 —
 * 파티션 테이블에서 전 구간 스캔이 나면 그 조회 하나가 DB 를 점유하고, 그 사이 감사 INSERT 가
 * 밀리면 INV-6 규칙상 **모든 권한 변경이 롤백**된다.
 */
export default function AuditPage() {
  const now = new Date();
  const [from, setFrom] = useState(isoLocal(new Date(now.getTime() - DEFAULT_DAYS * 86_400_000)));
  const [to, setTo] = useState(isoLocal(new Date(now.getTime() + 3_600_000)));
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [targetId, setTargetId] = useState('');
  const [items, setItems] = useState<AuditEntryView[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res = await endpoints.auditLogs({
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          actorId: actorId || undefined,
          action: action || undefined,
          targetId: targetId || undefined,
          size: 100,
        });
        setItems(res.items);
        setTotal(res.total);
      } catch (err) {
        setError(errorText(err, '조회에 실패했습니다.'));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Shell title="감사 로그">
      <Banner error={error} />

      <Card title="조회 조건">
        <form onSubmit={search} style={{ display: 'grid', gap: 8, maxWidth: 640 }}>
          <div style={s.row}>
            <label style={s.muted}>시작</label>
            <input
              type="datetime-local" value={from} required
              onChange={(e) => setFrom(e.target.value)} style={s.input}
            />
            <label style={s.muted}>종료</label>
            <input
              type="datetime-local" value={to} required
              onChange={(e) => setTo(e.target.value)} style={s.input}
            />
          </div>
          <div style={s.row}>
            <input
              placeholder="행위자 ID (UUID)" value={actorId}
              onChange={(e) => setActorId(e.target.value)} style={{ ...s.input, flex: 1 }}
            />
            <input
              placeholder="행위 (예: role.grant)" value={action}
              onChange={(e) => setAction(e.target.value)} style={{ ...s.input, flex: 1 }}
            />
            <input
              placeholder="대상 ID (UUID)" value={targetId}
              onChange={(e) => setTargetId(e.target.value)} style={{ ...s.input, flex: 1 }}
            />
          </div>
          <button type="submit" style={s.button} disabled={busy}>{busy ? '조회 중…' : '조회'}</button>
        </form>
        <p style={s.muted}>
          기간은 <strong>필수</strong>이며 최대 92일입니다. 감사 로그는 월 파티션 테이블이라,
          기간 없는 조회는 전 구간 스캔이 되어 감사 기록 자체를 밀어냅니다.
        </p>
      </Card>

      <Card title={total === null ? '결과' : `결과 ${total}건 (최대 100건 표시)`}>
        {items.length === 0 ? (
          <Empty>{total === null ? '조건을 넣고 조회하세요.' : '해당 기록이 없습니다.'}</Empty>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>시각</th>
                <th style={s.th}>행위</th>
                <th style={s.th}>행위자</th>
                <th style={s.th}>대상</th>
                <th style={s.th}>내용</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                    {new Date(e.at).toLocaleString('ko-KR')}
                  </td>
                  <td style={s.td}><span style={s.tag}>{e.action}</span></td>
                  <td style={{ ...s.td, fontSize: 12 }}>{e.actorId ?? '시스템'}</td>
                  <td style={{ ...s.td, fontSize: 12 }}>
                    {e.targetType ? `${e.targetType}:${(e.targetId ?? '').slice(0, 8)}` : '—'}
                  </td>
                  <td style={s.td}>
                    <details>
                      <summary style={s.muted}>보기</summary>
                      <code style={s.code}>{JSON.stringify(e.detail, null, 2)}</code>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={s.muted}>
          비밀번호 해시·TOTP 시크릿·검증 토큰·스토리지 키는 <strong>기록 단계에서 제외</strong>되어
          여기에 나타나지 않습니다(가리는 것이 아니라 애초에 쓰지 않습니다).
        </p>
      </Card>
    </Shell>
  );
}
