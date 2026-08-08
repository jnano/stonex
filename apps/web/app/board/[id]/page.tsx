'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { endpoints, errorText, type BoardSummary, type PostSummary } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { boardTypeLabel } from '../../../lib/board-labels';
import { Banner, Card, Empty, Shell, s } from '../../../lib/ui';

/** 게시판 내 글 목록 (WP-B1) — 고정글 우선·최신순. 작성 화면은 WP-B2 */
export default function BoardPostsPage() {
  const params = useParams<{ id: string }>();
  const { can } = useSession();
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [items, setItems] = useState<PostSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PostSummary[] | null>(null);
  const [unansweredOnly, setUnansweredOnly] = useState(false);

  useEffect(() => {
    if (!params?.id) return;
    void Promise.all([endpoints.board(params.id), endpoints.boardPosts(params.id, { unansweredOnly })])
      .then(([b, p]) => {
        setBoard(b);
        setItems(p.items);
        setNextCursor(p.nextCursor);
      })
      .catch((e) => setError(errorText(e, '게시판을 불러오지 못했습니다.')))
      .finally(() => setLoaded(true));
  }, [params?.id, unansweredOnly]);

  const runSearch = () => {
    if (!params?.id) return;
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    void endpoints
      .searchPosts(params.id, query)
      .then(setResults)
      .catch((e) => setError(errorText(e, '검색에 실패했습니다.')));
  };

  const loadMore = () => {
    if (!params?.id || !nextCursor) return;
    void endpoints
      .boardPosts(params.id, { cursor: nextCursor, unansweredOnly })
      .then((p) => {
        setItems((prev) => [...prev, ...p.items]);
        setNextCursor(p.nextCursor);
      })
      .catch((e) => setError(errorText(e, '더 불러오지 못했습니다.')));
  };

  return (
    <Shell title={board ? board.name : '게시판'}>
      <Banner error={error} message={null} />
      <p style={{ ...s.row, justifyContent: 'space-between' }}>
        <Link href="/board" style={s.muted}>← 게시판 목록</Link>
        {board && (
          <span style={{ ...s.muted, fontSize: 12 }}>{boardTypeLabel(board.boardType)}</span>
        )}
        {/* write_policy=MODERATOR(공지·FAQ)에서는 운영자에게만 글쓰기를 보인다.
            표시 분기일 뿐이며 실제 차단은 서버가 403 으로 한다(BINV-1) */}
        {board?.status === 'ACTIVE'
          && (board.settings.write_policy === 'MEMBER' || can('board.moderate.all')) && (
          <Link href={`/board/${params?.id}/write`} style={{ fontWeight: 600 }}>글 쓰기</Link>
        )}
      </p>
      <div style={{ ...s.row, marginBottom: 12 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
          placeholder="검색 (2자 이상)"
          style={{ ...s.input, flex: 1 }}
        />
        <button onClick={runSearch} style={s.button}>검색</button>
        {board?.capabilities.includes('accepted-answer') && (
          <label style={{ ...s.row, gap: 4, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={unansweredOnly}
              onChange={(e) => setUnansweredOnly(e.target.checked)}
            />
            미해결만
          </label>
        )}
        {results !== null && (
          <button onClick={() => { setResults(null); setQuery(''); }} style={s.button}>초기화</button>
        )}
      </div>
      {results !== null && (
        <p style={s.muted}>검색 결과 {results.length}건</p>
      )}
      {loaded && (results ?? items).length === 0 && !error && (
        <Empty>{results !== null ? '검색 결과가 없습니다.' : '아직 게시글이 없습니다.'}</Empty>
      )}

      {/* 갤러리 레이아웃(§5 list_layout) — 프리셋이 화면에서 드러나게 한다.
          목록 응답에는 썸네일이 없으므로 제목 카드 격자로 표현한다 */}
      {board?.settings.list_layout === 'GALLERY' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {(results ?? items).map((post) => (
            <div key={post.id} style={{
              border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fff',
            }}>
              <Link href={`/board/${params?.id}/${post.id}`} style={{ fontWeight: 600 }}>
                {post.isPinned && '📌 '}{post.title}{post.isSecret && ' 🔒'}
              </Link>
              <div style={{ ...s.muted, fontSize: 12, marginTop: 6 }}>
                {post.ownerName} · 댓글 {post.commentCount} · 조회 {post.viewCount}
              </div>
            </div>
          ))}
        </div>
      ) : (
      <>
      {(results ?? items).map((post) => (
        <Card key={post.id}>
          <div style={{ ...s.row, justifyContent: 'space-between' }}>
            <div>
              {post.isPinned && <span style={{ marginRight: 6 }}>📌</span>}
              <Link href={`/board/${params?.id}/${post.id}`} style={{ fontWeight: 600 }}>
                {post.title}
              </Link>
              {board?.capabilities.includes('accepted-answer') && (
                <span style={{ ...s.muted, marginLeft: 6, fontSize: 12 }}>
                  {post.acceptedCommentId ? '✅ 해결됨' : '미해결'}
                </span>
              )}
              {post.status === 'DRAFT' && <span style={{ ...s.muted, marginLeft: 6 }}>(임시저장)</span>}
              {post.isSecret && <span style={{ marginLeft: 6 }}>🔒</span>}
            </div>
            <span style={{ ...s.muted, fontSize: 12 }}>
              {post.ownerName} · 댓글 {post.commentCount} · 조회 {post.viewCount} ·{' '}
              {new Date(post.createdAt).toLocaleDateString('ko-KR')}
            </span>
          </div>
        </Card>
      ))}
      </>
      )}
      {results === null && nextCursor && (
        <p style={{ textAlign: 'center' }}>
          <button onClick={loadMore} style={s.button}>더 보기</button>
        </p>
      )}
    </Shell>
  );
}
