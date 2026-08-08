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
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!params?.id) return;
    void Promise.all([endpoints.board(params.id), endpoints.boardPosts(params.id)])
      .then(([b, p]) => {
        setBoard(b);
        setItems(p.items);
      })
      .catch((e) => setError(errorText(e, '게시판을 불러오지 못했습니다.')))
      .finally(() => setLoaded(true));
  }, [params?.id]);

  return (
    <Shell title={board ? board.name : '게시판'}>
      <Banner error={error} message={null} />
      <p style={s.muted}>
        <Link href="/board">← 게시판 목록</Link>
      </p>
      {loaded && items.length === 0 && !error && <Empty>아직 게시글이 없습니다.</Empty>}
      {items.map((post) => (
        <Card key={post.id}>
          <div style={{ ...s.row, justifyContent: 'space-between' }}>
            <div>
              {post.isPinned && <span style={{ marginRight: 6 }}>📌</span>}
              <Link href={`/board/${params?.id}/${post.id}`} style={{ fontWeight: 600 }}>
                {post.title}
              </Link>
              {post.status === 'DRAFT' && <span style={{ ...s.muted, marginLeft: 6 }}>(임시저장)</span>}
            </div>
            <span style={{ ...s.muted, fontSize: 12 }}>
              댓글 {post.commentCount} · {new Date(post.createdAt).toLocaleDateString('ko-KR')}
            </span>
          </div>
        </Card>
      ))}
    </Shell>
  );
}
