'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { endpoints, errorText, type CommentView, type PostDetail } from '../../../../lib/api';
import { Banner, Card, Empty, Shell, s } from '../../../../lib/ui';

/**
 * 글 읽기 (WP-B1).
 *
 * 본문은 **서버 렌더 캐시(bodyHtml)만** 표시한다 — bodyMd 를 화면에서 직접 렌더하는 것은
 * 금지다(G-2·R-B2). B1 의 bodyHtml 은 전량 이스케이프라 dangerouslySetInnerHTML 이
 * 안전하며, B2 의 마크다운 파이프라인도 같은 계약(서버 새니타이즈)을 유지한다.
 * 댓글 작성·트리 접기는 WP-B3.
 */
export default function PostPage() {
  const params = useParams<{ id: string; postId: string }>();
  const [post, setPost] = useState<PostDetail | null>(null);
  const [comments, setComments] = useState<CommentView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.postId) return;
    void Promise.all([endpoints.post(params.postId), endpoints.postComments(params.postId)])
      .then(([p, c]) => {
        setPost(p);
        setComments(c);
      })
      .catch((e) => setError(errorText(e, '게시글을 불러오지 못했습니다.')));
  }, [params?.postId]);

  return (
    <Shell title={post?.title ?? '게시글'}>
      <Banner error={error} message={null} />
      <p style={s.muted}>
        <Link href={`/board/${params?.id}`}>← 글 목록</Link>
      </p>

      {post && (
        <Card>
          <div style={{ ...s.muted, fontSize: 12, marginBottom: 12 }}>
            {new Date(post.createdAt).toLocaleString('ko-KR')}
            {post.updatedAt !== post.createdAt && ' (수정됨)'}
          </div>
          <div dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
          {post.attachments.length > 0 && (
            <ul style={{ marginTop: 16, paddingLeft: 18, fontSize: 13 }}>
              {post.attachments.map((a) => (
                <li key={a.fileId}>
                  📎 {a.name} ({Math.ceil(a.sizeBytes / 1024)}KB)
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title={`댓글 ${comments.length}개`}>
        {comments.length === 0 && <Empty>아직 댓글이 없습니다.</Empty>}
        {comments.map((c) => (
          <div
            key={c.id}
            style={{
              marginLeft: Math.min(c.depth, 3) * 20,
              padding: '8px 0',
              borderBottom: '1px solid #f1f5f9',
            }}
          >
            <div style={{ ...s.muted, fontSize: 11 }}>
              {new Date(c.createdAt).toLocaleString('ko-KR')}
            </div>
            <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />
          </div>
        ))}
      </Card>
    </Shell>
  );
}
