'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { endpoints, errorText, type CommentView, type PostDetail } from '../../../../lib/api';
import { useSession } from '../../../../lib/session';
import { Banner, Card, Empty, Shell, s } from '../../../../lib/ui';

/** 표시 깊이 상한 (§9.2) — 저장은 무제한, 표시만 접는다(R-B3 렌더 폭발 방지) */
const MAX_DISPLAY_DEPTH = 3;

/** 반응 종류 — 이모지는 저장 값, label 은 표시·풍선 도움말(title) 전용 */
const REACTIONS: Array<{ kind: string; label: string }> = [
  { kind: '👍', label: '좋아요' },
  { kind: '❤️', label: '공감' },
  { kind: '😄', label: '즐거움' },
];

const isImage = (mime: string): boolean => mime.startsWith('image/');
const linkButton = (color: string) => ({
  border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color,
});

/**
 * 글 읽기 (WP-B1~B6).
 *
 * 본문·댓글은 **서버 렌더 캐시(bodyHtml)만** 표시한다(G-2·R-B2). 댓글 트리는 path
 * 순서로 한 번에 받고 깊이 상한 초과분은 접는다 — 펼침/접기 토글(B6).
 * 수정·삭제·운영 버튼은 **표시만** 가른다 — 실제 차단은 서버의 403/404 다(§3·§8.4).
 */
export default function PostPage() {
  const params = useParams<{ id: string; postId: string }>();
  const router = useRouter();
  const { me, can } = useSession();
  const [post, setPost] = useState<PostDetail | null>(null);
  const [comments, setComments] = useState<CommentView[]>([]);
  const [reactions, setReactions] = useState<Array<{ kind: string; count: number; mine: boolean }>>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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
  const visible = comments.filter(
    (c) => c.depth < MAX_DISPLAY_DEPTH || [...expanded].some((id) => isDescendantOf(c, id)),
  );
  const hiddenChildren = (parent: CommentView): number =>
    comments.filter((c) => c.depth >= MAX_DISPLAY_DEPTH && isDescendantOf(c, parent.id)).length;

  /** 서버 호출 공통 — 성공하면 다시 읽어 화면을 서버 상태에 맞춘다 */
  const run = (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void fn()
      .then(() => {
        if (done) setMessage(done);
        return load();
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const removePost = () => {
    if (!params?.postId || !window.confirm('이 글을 삭제할까요? 되돌릴 수 없습니다.')) return;
    setBusy(true);
    void endpoints
      .deletePost(params.postId)
      .then(() => router.push(`/board/${params.id}`))
      .catch((e) => {
        setError(errorText(e, '글을 삭제하지 못했습니다.'));
        setBusy(false);
      });
  };

  /** .all 보유자는 관리자 경로, 게시판 위임자는 일반 경로 — 라우트가 분리돼 있다(§7.3) */
  const moderate = (body: { pin?: boolean; hide?: boolean }) => {
    if (!params?.postId) return;
    const id = params.postId;
    run(
      () => (can('board.moderate.all')
        ? endpoints.moderatePostAsAdmin(id, body)
        : endpoints.moderatePost(id, body)),
      '처리했습니다.',
    );
  };

  const report = () => {
    const reason = window.prompt('신고 사유를 입력하세요 (300자 이내)');
    if (!reason?.trim() || !params?.postId) return;
    const id = params.postId;
    run(() => endpoints.reportPost(id, reason.trim().slice(0, 300)), '신고를 접수했습니다.');
  };

  const mine = post !== null && me !== null && post.ownerId === me.id;
  const canModerate = can('board.moderate.all') || can('board.moderate');

  return (
    <Shell title={post?.title ?? '게시글'}>
      <Banner error={error} message={message} />
      <p style={s.muted}>
        <Link href={`/board/${params?.id}`}>← 글 목록</Link>
      </p>

      {post && (
        <Card>
          <div style={{ ...s.row, justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ ...s.muted, fontSize: 12 }}>
              <strong>{post.ownerName}</strong> · {new Date(post.createdAt).toLocaleString('ko-KR')}
              {post.updatedAt !== post.createdAt && ' (수정됨)'}
              {' · 조회 '}
              {post.viewCount}
              {post.isPinned && ' · 📌 고정'}
              {post.status === 'HIDDEN' && ' · 숨김'}
              {post.tags.length > 0 && ` · ${post.tags.map((t) => `#${t}`).join(' ')}`}
            </span>
            <span style={s.row}>
              {mine && (
                <>
                  <Link href={`/board/${params?.id}/${params?.postId}/edit`} style={{ fontSize: 13 }}>
                    수정
                  </Link>
                  <button onClick={removePost} disabled={busy} style={linkButton('#b91c1c')}>
                    삭제
                  </button>
                </>
              )}
              {canModerate && (
                <>
                  <button onClick={() => moderate({ pin: !post.isPinned })} disabled={busy}
                    title="목록 상단에 고정" style={linkButton('#64748b')}>
                    {post.isPinned ? '고정 해제' : '고정'}
                  </button>
                  <button onClick={() => moderate({ hide: post.status !== 'HIDDEN' })} disabled={busy}
                    title="글을 숨기거나 다시 공개" style={linkButton('#64748b')}>
                    {post.status === 'HIDDEN' ? '숨김 해제' : '숨기기'}
                  </button>
                  <Link href={`/admin/board?move=${params?.postId}`} style={{ fontSize: 12 }} title="다른 게시판으로 이동">
                    이동
                  </Link>
                </>
              )}
            </span>
          </div>

          <div dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />

          {/* 이미지는 본문 아래에 그대로 띄운다 — 첨부 목록으로만 두면 클릭해도 볼 수 없었다(B6) */}
          {post.attachments.filter((a) => isImage(a.mimeType)).map((a) => (
            <p key={a.fileId} style={{ margin: '12px 0' }}>
              {/* next/image 를 쓰지 않는다 — 서명 URL 은 만료가 있고 호스트가 배포마다
                  달라(범용 배포, §13.2) 이미지 최적화 도메인 화이트리스트를 고정할 수 없다 */}
              <img src={a.url} alt={a.name} style={{ maxWidth: '100%', borderRadius: 6 }} />
            </p>
          ))}
          {post.attachments.some((a) => !isImage(a.mimeType)) && (
            <ul style={{ marginTop: 16, paddingLeft: 18, fontSize: 13 }}>
              {post.attachments.filter((a) => !isImage(a.mimeType)).map((a) => (
                <li key={a.fileId}>
                  📎 <a href={a.url} target="_blank" rel="noreferrer">{a.name}</a>{' '}
                  ({Math.ceil(a.sizeBytes / 1024)}KB)
                </li>
              ))}
            </ul>
          )}

          <div style={{ ...s.row, marginTop: 14 }}>
            <button onClick={report} title="이 글 신고" style={{ ...s.button, fontSize: 12 }}>
              🚩 신고
            </button>
            {REACTIONS.map(({ kind, label }) => {
              const entry = reactions.find((r) => r.kind === kind);
              const pressed = entry?.mine === true;
              return (
                <button
                  key={kind}
                  onClick={() => params?.postId && run(() => endpoints.toggleReaction(params.postId, kind))}
                  title={pressed ? `${label} 취소` : label}
                  aria-pressed={pressed}
                  disabled={busy}
                  style={{
                    ...s.button,
                    border: pressed ? '1px solid #2563eb' : '1px solid #d1d5db',
                    background: pressed ? '#eff6ff' : '#fff',
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
        {visible.map((c) => {
          const isMine = me !== null && c.ownerId === me.id && c.status !== 'DELETED';
          const isEditing = editingComment === c.id;
          return (
            <div
              key={c.id}
              style={{
                marginLeft: Math.min(c.depth, MAX_DISPLAY_DEPTH) * 20,
                padding: '8px 0',
                borderBottom: '1px solid #f1f5f9',
              }}
            >
              <div style={{ ...s.muted, fontSize: 11 }}>
                <strong>{c.ownerName}</strong> · {new Date(c.createdAt).toLocaleString('ko-KR')}
              </div>

              {isEditing ? (
                <div style={{ display: 'grid', gap: 6, margin: '6px 0' }}>
                  <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={3}
                    style={{ ...s.input, resize: 'vertical' }} />
                  <div style={s.row}>
                    <button
                      onClick={() => run(
                        () => endpoints.updateComment(c.id, editDraft).then(() => setEditingComment(null)),
                        '댓글을 수정했습니다.',
                      )}
                      disabled={busy || !editDraft.trim()}
                      style={s.button}
                    >
                      저장
                    </button>
                    <button onClick={() => setEditingComment(null)} style={s.button}>취소</button>
                  </div>
                </div>
              ) : (
                <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />
              )}

              <div style={s.row}>
                {c.status !== 'DELETED' && (
                  <>
                    <button onClick={() => setReplyTo(replyTo === c.id ? null : c.id)} style={linkButton('#2563eb')}>
                      {replyTo === c.id ? '답글 취소' : '답글'}
                    </button>
                    {REACTIONS.map(({ kind, label }) => {
                      const entry = c.reactions.find((r) => r.kind === kind);
                      const pressed = entry?.mine === true;
                      return (
                        <button
                          key={kind}
                          onClick={() => run(() => endpoints.toggleCommentReaction(c.id, kind))}
                          title={pressed ? `${label} 취소` : label}
                          aria-pressed={pressed}
                          disabled={busy}
                          style={linkButton(pressed ? '#2563eb' : '#64748b')}
                        >
                          {kind} {entry?.count ?? 0}
                        </button>
                      );
                    })}
                  </>
                )}
                {isMine && !isEditing && (
                  <>
                    <button
                      onClick={() => { setEditingComment(c.id); setEditDraft(c.bodyMd ?? ''); }}
                      style={linkButton('#64748b')}
                    >
                      수정
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm('이 댓글을 삭제할까요?')) {
                          run(() => endpoints.deleteComment(c.id), '댓글을 삭제했습니다.');
                        }
                      }}
                      style={linkButton('#b91c1c')}
                    >
                      삭제
                    </button>
                  </>
                )}
                {/* 펼침/접기 토글(B6) — 펼친 뒤 다시 접을 수 있다 */}
                {c.depth === MAX_DISPLAY_DEPTH - 1 && hiddenChildren(c) > 0 && (
                  <button
                    onClick={() => setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      return next;
                    })}
                    style={linkButton('#64748b')}
                  >
                    {expanded.has(c.id) ? '답글 접기' : `답글 ${hiddenChildren(c)}개 더보기`}
                  </button>
                )}
              </div>
            </div>
          );
        })}

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
            <button
              onClick={() => params?.postId && run(
                () => endpoints
                  .createComment(params.postId, { bodyMd: draft, parentId: replyTo ?? undefined })
                  .then(() => { setDraft(''); setReplyTo(null); }),
              )}
              disabled={busy || !draft.trim()}
              style={s.button}
            >
              댓글 등록
            </button>
          </div>
        </div>
      </Card>
    </Shell>
  );
}
