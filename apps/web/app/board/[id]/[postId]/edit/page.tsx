'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { endpoints, errorText } from '../../../../../lib/api';
import { Banner, Card, Shell, s } from '../../../../../lib/ui';

/**
 * 글 수정 (WP-B6).
 *
 * 원본은 `bodyMd`(정본)로 받아 그대로 보낸다 — 렌더·새니타이즈는 서버 몫이고(§7.1),
 * 화면은 미리보기 렌더를 하지 않는다. 수정 권한 판정은 서버의 `canEditPost` 가 하며
 * (작성자 ∨ 공동작성자 ∨ 운영자, §6.5), 권한이 없으면 저장이 404 로 끊긴다.
 */
export default function EditPostPage() {
  const params = useParams<{ id: string; postId: string }>();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!params?.postId) return;
    const post = await endpoints.post(params.postId);
    setTitle(post.title);
    setBodyMd(post.bodyMd);
  }, [params?.postId]);

  useEffect(() => {
    void load()
      .catch((e) => setError(errorText(e, '글을 불러오지 못했습니다.')))
      .finally(() => setLoaded(true));
  }, [load]);

  const submit = () => {
    if (!params?.postId) return;
    setBusy(true);
    setError(null);
    void endpoints
      .updatePost(params.postId, { title, bodyMd })
      .then(() => router.push(`/board/${params.id}/${params.postId}`))
      .catch((e) => {
        setError(errorText(e, '글을 저장하지 못했습니다.'));
        setBusy(false);
      });
  };

  return (
    <Shell title="글 수정">
      <Banner error={error} message={null} />
      <p style={s.muted}>
        <Link href={`/board/${params?.id}/${params?.postId}`}>← 글로 돌아가기</Link>
      </p>

      <Card>
        <div style={{ display: 'grid', gap: 10 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="제목"
            maxLength={300}
            style={s.input}
          />
          <textarea
            value={bodyMd}
            onChange={(e) => setBodyMd(e.target.value)}
            placeholder="본문 (마크다운 지원 — 표시 시 서버에서 안전하게 렌더됩니다)"
            rows={14}
            style={{ ...s.input, fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={s.row}>
            <button
              onClick={submit}
              disabled={busy || !loaded || !title.trim() || !bodyMd.trim()}
              style={s.button}
            >
              저장
            </button>
          </div>
          <p style={{ ...s.muted, fontSize: 12 }}>
            첨부는 이 화면에서 바꾸지 않습니다 — 첨부 교체는 후속 작업입니다.
          </p>
        </div>
      </Card>
    </Shell>
  );
}
