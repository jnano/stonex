'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { endpoints, errorText, type BoardSummary } from '../../lib/api';
import { Banner, Card, Empty, Shell, s, statusStyle } from '../../lib/ui';
import { visibilityLabel } from '../../lib/board-labels';

/**
 * 게시판 목록 (WP-B1).
 *
 * 서버가 정책 행범위(BINV-3)로 걸러 준 목록을 표시만 한다 — 화면에서 가시성을
 * 재판정하지 않는다(G-2). 비회원 접근 없음(DEC-4) — 미로그인 세션은 셸이 로그인으로 보낸다.
 */
export default function BoardListPage() {
  const [items, setItems] = useState<BoardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void endpoints
      .boards()
      .then((res) => setItems(res.items))
      .catch((e) => setError(errorText(e, '게시판 목록을 불러오지 못했습니다.')))
      .finally(() => setLoaded(true));
  }, []);

  return (
    <Shell title="게시판">
      <Banner error={error} message={null} />
      {loaded && items.length === 0 && !error && <Empty>접근 가능한 게시판이 없습니다.</Empty>}
      {items.map((b) => (
        <Card key={b.id}>
          <div style={{ ...s.row, justifyContent: 'space-between' }}>
            <div>
              <Link href={`/board/${b.id}`} style={{ fontWeight: 600, fontSize: 15 }}>
                {b.name}
              </Link>
              <div style={{ ...s.muted, fontSize: 12, marginTop: 4 }}>
                /{b.slug} · 글 {b.postCount}개
              </div>
            </div>
            <div style={s.row}>
              {b.visibility !== 'PUBLIC' && (
                <span style={statusStyle('unknown')}>{visibilityLabel(b.visibility)}</span>
              )}
              {b.status === 'ARCHIVED' && <span style={statusStyle('unknown')}>보관됨</span>}
            </div>
          </div>
        </Card>
      ))}
    </Shell>
  );
}
