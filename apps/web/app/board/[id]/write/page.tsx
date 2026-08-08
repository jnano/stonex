'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { endpoints, errorText, type Attachment, type BoardSummary } from '../../../../lib/api';
import { Banner, Card, Shell, s } from '../../../../lib/ui';

/**
 * 글 작성 (WP-B2).
 *
 * 마크다운은 **원본 그대로 서버에 보낸다** — 렌더·새니타이즈는 서버 몫이고(§7.1),
 * 화면에서 미리보기 렌더를 하지 않는다(G-2 가 마크다운 렌더러 import 를 정적 차단).
 *
 * 첨부는 드래그앤드랍(§7.2): 세션 발급 → 서명 URL 로 스토리지 직접 업로드 →
 * upload_id 로 완료 콜백(체크섬 포함) → 받은 fileId 를 글에 링크.
 */
export default function WritePostPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const upload = useCallback(
    async (file: File) => {
      if (!params?.id) return;
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

      const ticket = await endpoints.issueBoardUpload(params.id, {
        contentType: file.type || 'application/octet-stream',
        contentLength: file.size,
      });
      const put = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: buffer,
      });
      if (!put.ok) throw new Error('스토리지 업로드에 실패했습니다.');
      const attachment = await endpoints.completeBoardUpload({
        uploadId: ticket.uploadId,
        checksum,
        name: file.name,
      });
      setAttachments((prev) => [...prev, attachment]);
    },
    [params?.id],
  );

  useEffect(() => {
    if (!params?.id) return;
    // 첨부 허용 여부·상한은 게시판 설정을 따른다(§5) — 서버도 같은 값으로 강제한다
    void endpoints.board(params.id).then(setBoard).catch(() => undefined);
  }, [params?.id]);

  const attachmentsEnabled =
    board === null
      ? true
      : board.capabilities.includes('attachment') && board.settings.editor.attachments;
  const maxAttachments = board?.settings.editor.max_attachments ?? 10;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        for (const file of Array.from(e.dataTransfer.files)) await upload(file);
      } catch (err) {
        setError(errorText(err, '첨부 업로드에 실패했습니다.'));
      } finally {
        setBusy(false);
      }
    })();
  };

  const submit = () => {
    if (!params?.id) return;
    setBusy(true);
    setError(null);
    void endpoints
      .createPost(params.id, {
        title,
        bodyMd,
        attachmentFileIds: attachments.map((a) => a.fileId),
      })
      .then((post) => router.push(`/board/${params.id}/${post.id}`))
      .catch((e) => {
        setError(errorText(e, '글을 등록하지 못했습니다.'));
        setBusy(false);
      });
  };

  return (
    <Shell title="글 쓰기">
      <Banner error={error} message={null} />
      <p style={s.muted}>
        <Link href={`/board/${params?.id}`}>← 글 목록</Link>
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

          {attachmentsEnabled && <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragOver ? '#2563eb' : '#cbd5e1'}`,
              borderRadius: 8, padding: 16, textAlign: 'center',
              color: '#64748b', fontSize: 13,
              background: dragOver ? '#eff6ff' : 'transparent',
            }}
          >
            파일을 여기에 끌어다 놓으면 첨부됩니다 — 최대 {maxAttachments}개
            (이미지는 서버에서 EXIF 제거·재인코딩)
          </div>}

          {attachments.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {attachments.map((a) => (
                <li key={a.fileId}>
                  {a.name} ({Math.ceil(a.sizeBytes / 1024)}KB){' '}
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.fileId !== a.fileId))}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c', fontSize: 12 }}
                  >
                    제거
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div style={s.row}>
            <button onClick={submit} disabled={busy || !title.trim() || !bodyMd.trim()} style={s.button}>
              등록
            </button>
          </div>
        </div>
      </Card>
    </Shell>
  );
}
