'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { endpoints, errorText } from '../../lib/api';
import { Banner, Card, Empty, Shell, s } from '../../lib/ui';

interface Row {
  id: string;
  kind: string;
  payload: { boardId?: string; postId?: string };
  createdAt: string;
  readAt: string | null;
}

const KIND_LABEL: Record<string, string> = {
  'comment.created': '내 글에 새 댓글이 달렸습니다',
  'reaction.added': '내 글에 반응이 추가되었습니다',
};

/**
 * 알림 (WP-B3 — notification 기반 모듈).
 *
 * 알림에는 링크·최소 메타만 들어 있다(§6.5) — 내용은 링크를 열 때 서버가 접근을
 * 재판정한 뒤에야 보인다. 접근이 사라진 글의 알림은 클릭 시 404 로 끝난다(유출 없음).
 */
export default function NotificationsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setRows(await endpoints.notifications());
  }, []);

  useEffect(() => {
    void load()
      .catch((e) => setError(errorText(e, '알림을 불러오지 못했습니다.')))
      .finally(() => setLoaded(true));
  }, [load]);

  const markRead = (id: string) => {
    void endpoints
      .markNotificationRead(id)
      .then(load)
      .catch((e) => setError(errorText(e, '읽음 처리에 실패했습니다.')));
  };

  return (
    <Shell title="알림">
      <Banner error={error} message={null} />
      {loaded && rows.length === 0 && !error && <Empty>알림이 없습니다.</Empty>}
      {rows.map((n) => (
        <Card key={n.id}>
          <div style={{ ...s.row, justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontWeight: n.readAt ? 400 : 700 }}>
                {KIND_LABEL[n.kind] ?? n.kind}
              </span>
              <div style={{ ...s.muted, fontSize: 12, marginTop: 4 }}>
                {new Date(n.createdAt).toLocaleString('ko-KR')}
              </div>
            </div>
            <div style={s.row}>
              {n.payload.boardId && n.payload.postId && (
                <Link href={`/board/${n.payload.boardId}/${n.payload.postId}`} style={{ fontSize: 13 }}>
                  글 보기
                </Link>
              )}
              {!n.readAt && (
                <button onClick={() => markRead(n.id)} style={s.button}>
                  읽음
                </button>
              )}
            </div>
          </div>
        </Card>
      ))}
    </Shell>
  );
}
