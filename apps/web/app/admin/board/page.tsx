'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  endpoints, errorText, type BoardSummary, type BriResult, type ReportView,
} from '../../../lib/api';
import { Banner, Card, Empty, Shell, s, statusStyle } from '../../../lib/ui';
import { boardTypeLabel, capabilityLabel, visibilityLabel } from '../../../lib/board-labels';

const BOARD_TYPES = ['FORUM', 'NOTICE', 'QNA', 'GALLERY', 'FAQ'];
const VISIBILITIES = ['PUBLIC', 'RESTRICTED', 'PRIVATE'];

/**
 * 게시판 관리 콘솔 (WP-B5).
 *
 * 특화 게시판은 **프리셋 + 설정 + 기능모듈 토글**로 만든다 — 코드 재배포가 없다(§5).
 * 신고 처리(R-B15): 자동 발동은 임시 숨김까지이며, 삭제·복구는 여기서의 명시적 결정이다.
 */
export default function AdminBoardPageWrapper() {
  // useSearchParams 는 Suspense 경계를 요구한다(Next App Router)
  return (
    <Suspense fallback={<Shell title="게시판 관리">불러오는 중…</Shell>}>
      <AdminBoardPage />
    </Suspense>
  );
}

function AdminBoardPage() {
  const searchParams = useSearchParams();
  // 글 읽기 화면의 "이동" 링크가 ?move=<postId> 로 들어온다 — 대상 게시판만 고르면 된다
  const movePostId = searchParams.get('move');
  const [boardList, setBoardList] = useState<BoardSummary[]>([]);
  const [reports, setReports] = useState<ReportView[]>([]);
  const [patrol, setPatrol] = useState<BriResult[]>([]);
  const [caps, setCaps] = useState<Record<string, Array<{ key: string; enabled: boolean }>>>({});
  const [openCaps, setOpenCaps] = useState<string | null>(null);
  const [draft, setDraft] = useState({ slug: '', name: '', boardType: 'FORUM', visibility: 'PUBLIC' });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, r, p] = await Promise.all([
      endpoints.boards(),
      endpoints.boardReports().catch(() => []),
      endpoints.boardPatrol().catch(() => []),
    ]);
    setBoardList(b.items);
    setReports(r);
    setPatrol(p);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(errorText(e, '불러오지 못했습니다.')));
  }, [load]);

  const createBoard = () => {
    setError(null);
    void endpoints
      .createBoard(draft)
      .then(() => {
        setMessage(`게시판 "${draft.name}" 을 만들었습니다 (${boardTypeLabel(draft.boardType)} 프리셋 적용).`);
        setDraft({ slug: '', name: '', boardType: 'FORUM', visibility: 'PUBLIC' });
        return load();
      })
      .catch((e) => setError(errorText(e, '게시판을 만들지 못했습니다.')));
  };

  const toggleCapsPanel = (boardId: string) => {
    if (openCaps === boardId) {
      setOpenCaps(null);
      return;
    }
    void endpoints
      .boardCapabilities(boardId)
      .then((list) => {
        setCaps((prev) => ({ ...prev, [boardId]: list }));
        setOpenCaps(boardId);
      })
      .catch((e) => setError(errorText(e)));
  };

  const setCapability = (boardId: string, key: string, enabled: boolean) => {
    void endpoints
      .setBoardCapability(boardId, key, enabled)
      .then(() => endpoints.boardCapabilities(boardId))
      .then((list) => setCaps((prev) => ({ ...prev, [boardId]: list })))
      .catch((e) => setError(errorText(e)));
  };

  const resolve = (id: string, uphold: boolean) => {
    void endpoints
      .resolveReport(id, uphold)
      .then(() => {
        setMessage(uphold ? '신고를 승인해 글을 삭제했습니다.' : '신고를 기각했습니다 (숨김이었다면 복구).');
        return load();
      })
      .catch((e) => setError(errorText(e)));
  };

  return (
    <Shell title="게시판 관리">
      <Banner error={error} message={message} />

      {movePostId && (
        <Card title="글 이동">
          <p style={s.muted}>
            선택한 글을 다른 게시판으로 옮깁니다. 이동해도 삭제가 아니며 감사에 남습니다.
          </p>
          <div style={s.row}>
            {boardList.map((b) => (
              <button
                key={b.id}
                onClick={() => {
                  void endpoints
                    .moderatePostAsAdmin(movePostId, { moveToBoardId: b.id })
                    .then(() => setMessage(`"${b.name}" 게시판으로 옮겼습니다.`))
                    .catch((e) => setError(errorText(e, '이동하지 못했습니다.')));
                }}
                style={s.button}
              >
                {b.name}
              </button>
            ))}
          </div>
          <p style={{ ...s.muted, fontSize: 12, marginTop: 8 }}>
            <Link href={`/board`}>게시판 목록으로</Link>
          </p>
        </Card>
      )}

      <Card title="게시판 만들기 (프리셋 — 재배포 없는 특화)">
        <div style={{ ...s.row }}>
          <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
            placeholder="slug (소문자·하이픈)" style={s.input} />
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="이름" style={s.input} />
          <select value={draft.boardType} onChange={(e) => setDraft({ ...draft, boardType: e.target.value })} style={s.input}>
            {BOARD_TYPES.map((t) => <option key={t} value={t}>{boardTypeLabel(t)}</option>)}
          </select>
          <select value={draft.visibility} onChange={(e) => setDraft({ ...draft, visibility: e.target.value })} style={s.input}>
            {VISIBILITIES.map((v) => <option key={v} value={v}>{visibilityLabel(v)}</option>)}
          </select>
          <button onClick={createBoard} disabled={!draft.slug || !draft.name} style={s.button}>생성</button>
        </div>
      </Card>

      <Card title={`게시판 ${boardList.length}개`}>
        {boardList.length === 0 && <Empty>게시판이 없습니다.</Empty>}
        {boardList.map((b) => (
          <div key={b.id} style={{ padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ ...s.row, justifyContent: 'space-between' }}>
              <div>
                <Link href={`/board/${b.id}`} style={{ fontWeight: 600 }}>{b.name}</Link>
                <span style={{ ...s.muted, marginLeft: 8, fontSize: 12 }}>
                  /{b.slug} · {boardTypeLabel(b.boardType)} · {visibilityLabel(b.visibility)} · 글 {b.postCount}
                </span>
              </div>
              <button onClick={() => toggleCapsPanel(b.id)} style={s.button}>기능모듈</button>
            </div>
            {openCaps === b.id && caps[b.id] && (
              <div style={{ ...s.row, marginTop: 8 }}>
                {caps[b.id].map((c) => (
                  <label key={c.key} style={{ ...s.row, fontSize: 13, gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) => setCapability(b.id, c.key, e.target.checked)}
                    />
                    {capabilityLabel(c.key)}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card title={`신고 처리 대기 ${reports.length}건`}>
        {reports.length === 0 && <Empty>대기 중인 신고가 없습니다.</Empty>}
        {reports.map((r) => (
          <div key={r.id} style={{ ...s.row, justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
            <div>
              <strong>{r.postTitle}</strong>
              <div style={{ ...s.muted, fontSize: 12 }}>
                사유: {r.reason} · 이 글 신고 {r.openCountForPost}건 · {new Date(r.createdAt).toLocaleString('ko-KR')}
              </div>
            </div>
            <div style={s.row}>
              <button onClick={() => resolve(r.id, true)} style={{ ...s.button, color: '#b91c1c' }}>
                승인(삭제)
              </button>
              <button onClick={() => resolve(r.id, false)} style={s.button}>기각(복구)</button>
            </div>
          </div>
        ))}
        <p style={{ ...s.muted, fontSize: 12, marginTop: 8 }}>
          집단 신고의 자동 처리는 <strong>임시 숨김까지</strong>입니다 — 삭제는 여기서의 명시적 결정만 가능합니다.
        </p>
      </Card>

      <Card title="게시판 불변식 순찰 (BRI-1~4)">
        {patrol.length === 0 && <Empty>순찰 기록이 아직 없습니다.</Empty>}
        <div style={s.row}>
          {patrol.map((r) => (
            <span key={r.id} style={statusStyle(r.violations === 0 || r.remediated >= r.violations ? 'ok' : 'failed')}>
              {r.id} {r.title}: 위반 {r.violations} / 보정 {r.remediated}
            </span>
          ))}
        </div>
      </Card>
    </Shell>
  );
}
