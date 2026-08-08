'use client';

import { useEffect, useState } from 'react';
import { ApiError, endpoints, type VersionView } from '../../../lib/api';
import { Banner, Card, Empty, Shell, s, statusStyle } from '../../../lib/ui';

const COMPONENT_LABEL: Record<string, string> = {
  ok: '정상',
  mismatch: '불일치',
  unknown: '확인 불가',
};

/** 구분 이름을 한국어로 — Keep a Changelog 의 표준 구분 */
const KIND_LABEL: Record<string, string> = {
  Added: '추가',
  Changed: '변경',
  Fixed: '수정',
  Removed: '제거',
  Deprecated: '폐기 예정',
  Security: '보안',
};

/**
 * 버전 관리.
 *
 * 버전 문자열만 보여주는 것으로는 부족하다 — **코드는 새것인데 마이그레이션이나 시드가 안 붙은
 * 상태**가 실제 사고를 만들고, 그때 증상은 "왜 이 권한이 없지?" 같은 엉뚱한 형태로 나타난다.
 * 그래서 정의와 실제를 대조한 결과를 함께 놓는다.
 *
 * 릴리스 이력은 화면에 박아 두지 않고 저장소의 `CHANGELOG.md` 를 읽는다 —
 * 같은 사실이 두 곳에 있으면 언젠가 갈라진다(§15.1).
 */
export default function VersionPage() {
  const [data, setData] = useState<VersionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void endpoints
      .version()
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? `${e.message} (${e.status})` : '조회에 실패했습니다.'),
      );
  }, []);

  const hasProblem = data?.components.some((c) => c.status !== 'ok') ?? false;

  return (
    <Shell title="버전 관리">
      <Banner error={error} />

      {!data ? (
        <Empty>{error ? '' : '불러오는 중…'}</Empty>
      ) : (
        <>
          <Card title="현재 배포">
            <div style={{ ...s.row, gap: 20, marginBottom: 12 }}>
              <div>
                <div style={s.muted}>버전</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{data.version}</div>
              </div>
              <div>
                <div style={s.muted}>커밋</div>
                <div style={{ fontSize: 14 }}>
                  {data.commit ? data.commit.slice(0, 10) : '주입되지 않음'}
                </div>
              </div>
              <div>
                <div style={s.muted}>기동 시각</div>
                <div style={{ fontSize: 14 }}>
                  {new Date(data.startedAt).toLocaleString('ko-KR')}
                </div>
              </div>
            </div>

            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>구성 요소</th>
                  <th style={s.th}>상태</th>
                  <th style={s.th}>내용</th>
                </tr>
              </thead>
              <tbody>
                {data.components.map((c) => (
                  <tr key={c.label}>
                    <td style={s.td}>{c.label}</td>
                    <td style={s.td}>
                      <span style={statusStyle(c.status === 'ok' ? 'ok' : c.status === 'mismatch' ? 'failed' : 'unknown')}>
                        {COMPONENT_LABEL[c.status] ?? c.status}
                      </span>
                    </td>
                    <td style={s.td}>{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p style={s.muted}>
              {hasProblem ? (
                <strong style={{ color: '#b91c1c' }}>
                  코드와 DB 상태가 어긋나 있습니다. 마이그레이션·시드가 적용됐는지 확인하세요 —
                  이 상태에서는 권한 판정이 설계와 다르게 동작할 수 있습니다.
                </strong>
              ) : (
                '버전 문자열은 빌드 시 주입한 값(APP_VERSION·GIT_COMMIT)을 쓰고, 없으면 CHANGELOG 최신 릴리스로 대신합니다.'
              )}
            </p>
          </Card>

          <Card title="릴리스 이력">
            {data.changelog.length === 0 ? (
              <Empty>CHANGELOG.md 를 찾을 수 없습니다.</Empty>
            ) : (
              data.changelog.map((entry) => (
                <div key={entry.version} style={{ marginBottom: 20 }}>
                  <div style={{ ...s.row, marginBottom: 4 }}>
                    <strong style={{ fontSize: 15 }}>{entry.version}</strong>
                    {entry.date && <span style={s.muted}>{entry.date}</span>}
                    {entry.version.toLowerCase() === 'unreleased' && (
                      <span style={statusStyle('unknown')}>미배포</span>
                    )}
                  </div>
                  {entry.sections.map((sec) => (
                    <div key={sec.kind} style={{ marginBottom: 6 }}>
                      <span style={s.tag}>{KIND_LABEL[sec.kind] ?? sec.kind}</span>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 22 }}>
                        {sec.items.map((item, i) => (
                          <li key={i} style={{ fontSize: 14 }}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ))
            )}
            <p style={s.muted}>
              출처는 저장소의 <code>CHANGELOG.md</code> 입니다. 화면에 목록을 따로 두지 않는 이유는,
              같은 사실이 두 곳에 있으면 언젠가 갈라지기 때문입니다.
            </p>
          </Card>
        </>
      )}
    </Shell>
  );
}
