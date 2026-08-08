'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  endpoints,
  errorText,
  type ActionView,
  type AnomalySignal,
  type FreezeSummary,
  type PatrolStatusView,
} from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { Banner, Card, Empty, Shell, s, statusStyle } from '../../../lib/ui';

const STATUS_LABEL: Record<string, string> = {
  ok: '이상 없음',
  violated: '위반',
  failed: '검사 실패',
  unknown: '판정 기록 없음',
  unavailable: '검사 불가',
};

/**
 * 거버넌스 대시보드 (§14, RT-20).
 *
 * 이 화면의 제1 원칙: **"검사 실패"를 "이상 없음"과 같은 것으로 보이게 하지 않는다.**
 * 감시 장치가 꺼진 상태를 정상으로 오인하면 대시보드가 있는 것이 없는 것만 못하다.
 * 그래서 판정 기록이 없는 불변식도 'ok' 가 아니라 '판정 기록 없음'으로 따로 표시한다.
 */
export default function GovernancePage() {
  const { can } = useSession();
  const [status, setStatus] = useState<PatrolStatusView | null>(null);
  const [actions, setActions] = useState<ActionView[]>([]);
  const [freezes, setFreezes] = useState<FreezeSummary[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalySignal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canRelease = can('governance.freeze.manage');

  const load = useCallback(async () => {
    const [st, ac, fz, an] = await Promise.all([
      endpoints.patrolStatus(),
      endpoints.governanceActions(20),
      endpoints.freezes(),
      endpoints.anomalies(24).catch(() => []),
    ]);
    setStatus(st);
    setActions(ac);
    setFreezes(fz);
    setAnomalies(an);
  }, []);

  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);

  const release = (id: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void (async () => {
      try {
        await endpoints.releaseFreeze(id, '콘솔에서 해제');
        await load();
        setMessage('동결을 해제했습니다.');
      } catch (e) {
        // 피동결자 본인이거나 승인 정족수가 없으면 403 + 사유가 온다
        setError(errorText(e, '해제에 실패했습니다.'));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Shell title="거버넌스">
      <Banner error={error} message={message} />

      <Card title="순찰 상태">
        {!status ? (
          <Empty>불러오는 중…</Empty>
        ) : (
          <>
            <div style={{ ...s.row, marginBottom: 12 }}>
              <span style={status.healthy ? statusStyle('ok') : statusStyle('failed')}>
                {status.healthy ? '가동 중' : '멎음 — 최근 실행 없음'}
              </span>
              {status.hasFailedChecks && (
                <span style={statusStyle('failed')}>검사 실패 있음</span>
              )}
              <span style={s.muted}>
                최근 실행{' '}
                {status.lastRunAt ? new Date(status.lastRunAt).toLocaleString('ko-KR') : '기록 없음'}
                {status.lastDurationMs !== null && ` · ${status.lastDurationMs}ms`}
              </span>
            </div>

            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>ID</th>
                  <th style={s.th}>불변식</th>
                  <th style={s.th}>대응</th>
                  <th style={s.th}>판정</th>
                  <th style={s.th}>위반</th>
                </tr>
              </thead>
              <tbody>
                {status.checks.map((c) => (
                  <tr key={c.id}>
                    <td style={s.td}>{c.id}</td>
                    <td style={s.td}>{c.title}</td>
                    <td style={s.td}><span style={s.tag}>{c.severity}</span></td>
                    <td style={s.td}>
                      <span style={statusStyle(c.status)}>{STATUS_LABEL[c.status] ?? c.status}</span>
                      {c.error && <div style={{ ...s.muted, color: '#b91c1c' }}>{c.error}</div>}
                    </td>
                    <td style={s.td}>{c.violations}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p style={s.muted}>
              <strong>&apos;검사 실패&apos;는 &apos;이상 없음&apos;이 아닙니다.</strong> 실패는 그 불변식이
              감시되지 않고 있다는 뜻이며, 판정 기록이 없는 항목도 정상으로 세지 않습니다.
            </p>

            {(status.escalated.length > 0 || status.unknownResourceTypes.length > 0) && (
              <div style={{ ...s.row, marginTop: 8 }}>
                {status.escalated.length > 0 && (
                  <span style={statusStyle('violated')}>
                    자동 조치 중단(상한 초과): {status.escalated.join(', ')}
                  </span>
                )}
                {status.unknownResourceTypes.length > 0 && (
                  <span style={statusStyle('unknown')}>
                    검사 불가 타입: {status.unknownResourceTypes.join(', ')}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="L-1 자동 조치 이력">
        {actions.length === 0 ? (
          <Empty>자동 조치 기록이 없습니다.</Empty>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>시각</th>
                <th style={s.th}>행위</th>
                <th style={s.th}>대상</th>
                <th style={s.th}>사유</th>
                <th style={s.th}>회수 전 내용</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a, i) => (
                <tr key={`${a.at}-${i}`}>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                    {new Date(a.at).toLocaleString('ko-KR')}
                  </td>
                  <td style={s.td}><span style={s.tag}>{a.action}</span></td>
                  <td style={{ ...s.td, fontSize: 12 }}>
                    {a.targetType ? `${a.targetType}:${(a.targetId ?? '').slice(0, 8)}` : '—'}
                  </td>
                  <td style={s.td}>{a.reason ?? '—'}</td>
                  <td style={{ ...s.td, fontSize: 12 }}>
                    {a.before
                      ? `${a.before.resourceType ?? ''} · ${a.before.effect ?? ''} · ${(a.before.subject ?? '').slice(0, 8)}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={s.muted}>
          회수 전 행 내용이 감사에 남아 있어 <code>scripts/restore-grants.ts</code> 로 되돌릴 수 있습니다.
        </p>
      </Card>

      <Card title="L-2 동결">
        {freezes.length === 0 ? (
          <Empty>활성 동결이 없습니다.</Empty>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>대상</th>
                <th style={s.th}>발동 근거</th>
                <th style={s.th}>사유</th>
                <th style={s.th}>시각</th>
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {freezes.map((f) => (
                <tr key={f.id}>
                  <td style={{ ...s.td, fontSize: 12 }}>{f.userId}</td>
                  <td style={s.td}><span style={s.tag}>{f.trigger}</span></td>
                  <td style={s.td}>{f.reason}</td>
                  <td style={s.td}>{new Date(f.frozenAt).toLocaleString('ko-KR')}</td>
                  <td style={s.td}>
                    {canRelease && (
                      <button onClick={() => release(f.id)} style={s.button} disabled={busy}>
                        해제 승인
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={s.muted}>
          동결은 <strong>권한 변경만</strong> 막고 서비스 이용은 유지합니다.
          해제는 피동결자 본인을 제외한 활성 최고관리자만 할 수 있습니다.
        </p>
      </Card>

      <Card title="이상 탐지 (최근 24시간)">
        {anomalies.length === 0 ? (
          <Empty>탐지된 신호가 없습니다.</Empty>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>규칙</th>
                <th style={s.th}>내용</th>
                <th style={s.th}>대상</th>
                <th style={s.th}>상세</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((a, i) => (
                <tr key={`${a.ruleId}-${a.actorId}-${i}`}>
                  <td style={s.td}><span style={s.tag}>{a.ruleId}</span></td>
                  <td style={s.td}>{a.title}</td>
                  <td style={{ ...s.td, fontSize: 12 }}>{a.actorId}</td>
                  <td style={{ ...s.td, fontSize: 12 }}>{JSON.stringify(a.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={s.muted}>
          탐지는 <strong>자동으로 동결하지 않습니다.</strong> 정상일 수도 있지만 설명이 필요한
          행동을 올릴 뿐이며, 동결은 사람이 판단해 발동합니다.
        </p>
      </Card>
    </Shell>
  );
}
