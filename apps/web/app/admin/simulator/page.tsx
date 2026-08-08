'use client';

import { useEffect, useState } from 'react';
import {
  endpoints,
  errorText,
  type PermissionCatalogItem,
  type SimulationResult,
} from '../../../lib/api';
import { Banner, Card, Shell, s } from '../../../lib/ui';

/** 평가기 §4.7 의 단계 — 화면이 "어디서 갈렸는가"를 그대로 보여준다 */
const STEPS = [
  { step: 0, label: '주체 상태', desc: '정지·탈퇴·미인증 계정 전면 차단' },
  { step: 1, label: '리소스 상태', desc: '삭제·정지된 리소스 접근 차단' },
  { step: 2, label: '명시적 거부', desc: 'DENY 는 모든 ALLOW 에 우선' },
  { step: 3, label: '역할 기반', desc: 'global 이거나, owned 이며 소유자일 때' },
  { step: 4, label: 'Grant', desc: '만료되지 않은 ALLOW Grant' },
  { step: 5, label: '기본 거부', desc: '해당 규칙 없음' },
];

const REASON_TEXT: Record<string, string> = {
  SUBJECT_NOT_ACTIVE: '주체가 활성 상태가 아님',
  RESOURCE_STATE: '리소스 상태가 접근 불가',
  EXPLICIT_DENY: '명시적 DENY Grant',
  ROLE_GLOBAL: '역할 보유 (global)',
  ROLE_OWNED: '역할 보유 (owned — 소유자 일치)',
  GRANT: 'ALLOW Grant',
  DEFAULT_DENY: '해당 규칙 없음 (기본 거부)',
};

/**
 * ADM-5 권한 시뮬레이터.
 *
 * **우위 검사를 적용하지 않는다**(§4.6-3). 제압할 수 없는 상대를 못 보게 하면
 * "왜 이 사람을 관리할 수 없는가"를 설명한다는 이 기능의 1차 용도가 사라진다.
 *
 * 질의는 **전건 감사에 남는다** — 권한 지도를 훑는 용도로 쓰여도 사후에 드러나야 한다(§14.4).
 */
export default function SimulatorPage() {
  const [catalog, setCatalog] = useState<PermissionCatalogItem[]>([]);
  const [subjectId, setSubjectId] = useState('');
  const [permission, setPermission] = useState('file.read');
  const [resourceType, setResourceType] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void endpoints.permissionCatalog().then(setCatalog).catch(() => undefined);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    void (async () => {
      try {
        setResult(
          await endpoints.simulate({
            subjectId,
            permission,
            resourceType: resourceType || undefined,
            resourceId: resourceId || undefined,
          }),
        );
      } catch (err) {
        // 비UUID·미등록 타입은 404 로 정규화된다 — 응답 형상이 존재 오라클이 되지 않도록
        setError(errorText(err, '질의에 실패했습니다.'));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Shell title="권한 시뮬레이터">
      <Banner error={error} />

      <Card title="질의">
        <form onSubmit={submit} style={s.form}>
          <input
            placeholder="대상 사용자 ID (UUID)" value={subjectId} required
            onChange={(e) => setSubjectId(e.target.value)} style={s.input}
          />
          <select value={permission} onChange={(e) => setPermission(e.target.value)} style={s.input}>
            {(catalog.length > 0
              ? catalog.map((c) => ({ code: c.code, label: `${c.code} (${c.scope})` }))
              : [{ code: 'file.read', label: 'file.read' }]
            ).map((o) => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
          <div style={s.row}>
            <select
              value={resourceType} onChange={(e) => setResourceType(e.target.value)}
              style={{ ...s.input, flex: 1 }}
            >
              <option value="">리소스 없음 (global 권한 질의)</option>
              <option value="file">file</option>
              <option value="domain">domain</option>
            </select>
            <input
              placeholder="리소스 ID (UUID)" value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
              style={{ ...s.input, flex: 1 }} disabled={!resourceType}
            />
          </div>
          <button type="submit" style={s.button} disabled={busy}>
            {busy ? '판정 중…' : '판정'}
          </button>
        </form>
        <p style={s.muted}>
          이 질의는 <strong>감사 로그에 남습니다</strong>(누가 무엇을 조회했는지 — §14.4).
          우위 검사는 적용되지 않으므로 상위 관리자에 대한 질의도 답합니다.
        </p>
      </Card>

      {result && (
        <Card title="판정 결과">
          <p style={{ fontSize: 18, margin: '0 0 12px' }}>
            <strong style={{ color: result.allow ? '#047857' : '#b91c1c' }}>
              {result.allow ? '허용' : '거부'}
            </strong>
            {' — '}
            {REASON_TEXT[result.reason] ?? result.reason}
          </p>

          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th} />
                <th style={s.th}>단계</th>
                <th style={s.th}>내용</th>
              </tr>
            </thead>
            <tbody>
              {STEPS.map((st) => {
                const reached = st.step <= result.step;
                const decided = st.step === result.step;
                return (
                  <tr key={st.step} style={decided ? { background: '#f9fafb' } : undefined}>
                    <td style={s.td}>{decided ? '▶' : reached ? '·' : ''}</td>
                    <td style={{ ...s.td, fontWeight: decided ? 600 : 400 }}>
                      {st.step}. {st.label}
                    </td>
                    <td style={{ ...s.td, color: reached ? '#374151' : '#d1d5db' }}>{st.desc}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={s.muted}>
            ▶ 표시가 판정이 결정된 단계입니다. 응답 사유는 <strong>사전 정의된 코드</strong>뿐이며,
            평가기 내부의 자유 텍스트는 서버 로그에만 남습니다(§10.2).
          </p>
        </Card>
      )}
    </Shell>
  );
}
