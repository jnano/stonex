'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { endpoints, errorText, type CommentView, type PostDetail } from '../../../../lib/api';
import { Banner, Card, Empty, Shell, s } from '../../../../lib/ui';

/** 표시 깊이 상한 (§9.2) — 저장은 무제한, 표시만 접는다(R-B3 렌더 폭발 방지) */
const MAX_DISPLAY_DEPTH = 3;
const REACTION_KINDS = ['👍', '❤️', '😄'];

/**
 * 글 읽기 (WP-B1~B3).
 *
 * 본문·댓글은 **서버 렌더 캐시(bodyHtml)만** 표시한다(G-2·R-B2). 댓글 트리는 path
 * 순서(전위순회)로 한 번에 받고, 깊이 상한 초과분은 "더보기"로 접는다 — 저장은
 * 무제한이되 렌더는 폭발하지 않는다(R-B3).
 */
export default function PostPage() {
  const params = useParams<{ id: string; postId: string }>();
  const [post, setPost] = useState<PostDetail | null>(null);
  const [comments, setComments] = useState<CommentView[]>([]);
  const [reactions, setReactions] = useState<Array<{ kind: string; count: number; mine: boolean }>>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!params?.postId) return;
    const [p, c, r] = await Promise.all([
      endpoints.post(params.postId),
      endpoints.postComments(params.postId),
      endpoints.reactions(params.postId),
    ]);
    setPost(p);
    setComments(c);
    setReactions(r);
  }, [params?.postId]);

  useEffect(() => {
    void load().catch((e) => setError(errorText(e, '게시글을 불러오지 못했습니다.')));
  }, [load]);

  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  const isDescendantOf = useCallback(
    (c: CommentView, ancestorId: string): boolean => {
      let current: CommentView | undefined = c;
      let guard = 0;
      while (current?.parentId && guard < 100) {
        if (current.parentId === ancestorId) return true;
        current = byId.get(current.parentId);
        guard += 1;
      }
      return false;
    },
    [byId],
  );
  // 접기: 상한 초과 댓글은 "더보기"를 누른 조상의 자손일 때만 표시. 데이터는 전부
  // 이미 로드돼 있으므로(트리 1회 로드) 이 필터는 표시에만 관여한다
  const visible = comments.filter(
    (c) => c.depth < MAX_DISPLAY_DEPTH || [...expanded].some((id) => isDescendantOf(c, id)),
  );
  const hiddenChildren = (parent: CommentView): number =>
    comments.filter((c) => c.depth >= MAX_DISPLAY_DEPTH && isDescendantOf(c, parent.id)).length;

  const submitComment = () => {
    if (!params?.postId || !draft.trim()) return;
    setBusy(true);
    void endpoints
      .createComment(params.postId, { bodyMd: draft, parentId: replyTo ?? undefined })
      .then(() => {
        setDraft('');
        setReplyTo(null);
        return load();
      })
      .catch((e) => setError(errorText(e, '댓글을 등록하지 못했습니다.')))
      .finally(() => setBusy(false));
  };

  const react = (kind: string) => {
    if (!params?.postId) return;
    void endpoints
      .toggleReaction(params.postId, kind)
      .then(() => endpoints.reactions(params.postId!))
      .then(setReactions)
      .catch((e) => setError(errorText(e, '반응을 처리하지 못했습니다.')));
  };

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
            {post.tags.length > 0 && <span> · {post.tags.map((t) => `#${t}`).join(' ')}</span>}
          </div>
          <div dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
          {post.attachments.length > 0 && (
            <ul style={{ marginTop: 16, paddingLeft: 18, fontSize: 13 }}>
              {post.attachments.map((a) => (
                <li key={a.fileId}>📎 {a.name} ({Math.ceil(a.sizeBytes / 1024)}KB)</li>
              ))}
            </ul>
          )}
          <div style={{ ...s.row, marginTop: 14 }}>
            {REACTION_KINDS.map((kind) => {
              const entry = reactions.find((r) => r.kind === kind);
              return (
                <button
                  key={kind}
                  onClick={() => react(kind)}
                  style={{
                    ...s.button,
                    ...(entry?.mine ? { background: '#eff6ff', borderColor: '#2563eb' } : {}),
                  }}
                >
                  {kind} {entry?.count ?? 0}
                </button>
              );
            })}
          </div>
        </Card>
      )}

      <Card title={`댓글 ${comments.length}개`}>
        {comments.length === 0 && <Empty>아직 댓글이 없습니다.</Empty>}
        {visible.map((c) => (
          <div
            key={c.id}
            style={{
              marginLeft: Math.min(c.depth, MAX_DISPLAY_DEPTH) * 20,
              padding: '8px 0',
              borderBottom: '1px solid #f1f5f9',
            }}
          >
            <div style={{ ...s.muted, fontSize: 11 }}>{new Date(c.createdAt).toLocaleString('ko-KR')}</div>
            <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />
            <div style={s.row}>
              {c.status !== 'DELETED' && (
                <button
                  onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#2563eb', fontSize: 12 }}
                >
                  {replyTo === c.id ? '답글 취소' : '답글'}
                </button>
              )}
              {c.depth === MAX_DISPLAY_DEPTH - 1 && !expanded.has(c.id) && hiddenChildren(c) > 0 && (
                <button
                  onClick={() => setExpanded((prev) => new Set(prev).add(c.id))}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', fontSize: 12 }}
                >
                  답글 {hiddenChildren(c)}개 더보기
                </button>
              )}
            </div>
          </div>
        ))}

        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {replyTo && <span style={{ ...s.muted, fontSize: 12 }}>↳ 대댓글 작성 중</span>}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="댓글 (마크다운 지원)"
            rows={3}
            style={{ ...s.input, resize: 'vertical' }}
          />
          <div style={s.row}>
            <button onClick={submitComment} disabled={busy || !draft.trim()} style={s.button}>
              댓글 등록
            </button>
          </div>
        </div>
      </Card>
    </Shell>
  );
}
