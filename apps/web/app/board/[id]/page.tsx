'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { endpoints, errorText, type BoardSummary, type PostSummary } from '../../../lib/api';
import { Banner, Card, Empty, Shell, s } from '../../../lib/ui';

/** 게시판 내 글 목록 (WP-B1) — 고정글 우선·최신순. 작성 화면은 WP-B2 */
export default function BoardPostsPage() {
  const params = useParams<{ id: string }>();
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [items, setItems] = useState<PostSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PostSummary[] | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    void Promise.all([endpoints.board(params.id), endpoints.boardPosts(params.id)])
      .then(([b, p]) => {
        setBoard(b);
        setItems(p.items);
        setNextCursor(p.nextCursor);
      })
      .catch((e) => setError(errorText(e, '게시판을 불러오지 못했습니다.')))
      .finally(() => setLoaded(true));
  }, [params?.id]);

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
      .boardPosts(params.id, nextCursor)
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
        {board?.status === 'ACTIVE' && (
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
      {(results ?? items).map((post) => (
        <Card key={post.id}>
          <div style={{ ...s.row, justifyContent: 'space-between' }}>
            <div>
              {post.isPinned && <span style={{ marginRight: 6 }}>📌</span>}
              <Link href={`/board/${params?.id}/${post.id}`} style={{ fontWeight: 600 }}>
                {post.title}
              </Link>
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
      {results === null && nextCursor && (
        <p style={{ textAlign: 'center' }}>
          <button onClick={loadMore} style={s.button}>더 보기</button>
        </p>
      )}
    </Shell>
  );
}
