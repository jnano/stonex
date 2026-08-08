'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, endpoints, type FileSummary, type ShareSummary } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { Banner, Card, Empty, Shell, s } from '../../../lib/ui';

/**
 * 파일 관리 (FILE-1~7).
 *
 * **업로드는 이 화면에 없다.** FILE-1 은 브라우저가 서명 URL 로 스토리지에 직접 PUT 하는
 * 구조인데, 개발용 MinIO 에 CORS 설정이 없어 브라우저 PUT 이 차단된다. 스토리지 버킷 정책은
 * 운영(S3)과 개발(MinIO)이 별개라 환경 구성 작업으로 분리했다 — 화면만 만들어 두면
 * "되는 줄 알았는데 안 되는" 상태가 된다.
 */
export default function FilesPage() {
  const { can } = useSession();
  const [items, setItems] = useState<FileSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [adminView, setAdminView] = useState(false);
  const [selected, setSelected] = useState<FileSummary | null>(null);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [subjectId, setSubjectId] = useState('');
  const [permission, setPermission] = useState('file.read');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canReadAll = can('file.read.all');

  const load = useCallback(async () => {
    const res = adminView ? await endpoints.allFiles() : await endpoints.files();
    setItems(res.items);
    setTotal(res.total);
  }, [adminView]);

  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      // 서버가 돌려준 사유를 그대로 보여준다 — 404 는 존재 은닉일 수도 있다(§10.2)
      setError(e instanceof ApiError ? `${e.message} (${e.status})` : '요청에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const select = (file: FileSummary) =>
    run(async () => {
      setSelected(file);
      setShares(await endpoints.fileShares(file.id).catch(() => []));
    });

  const share = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    void run(async () => {
      const next = await endpoints.createFileShare(selected.id, subjectId, [permission]);
      setShares(next);
      setSubjectId('');
      setMessage('공유했습니다.');
    });
  };

  const revoke = (grantId: string) =>
    run(async () => {
      if (!selected) return;
      await endpoints.revokeFileShare(selected.id, grantId);
      setShares(await endpoints.fileShares(selected.id));
      setMessage('공유를 회수했습니다.');
    });

  const download = (id: string) =>
    run(async () => {
      const { url, expiresInSeconds } = await endpoints.downloadUrl(id);
      setMessage(`다운로드 URL 발급 (${expiresInSeconds}초 유효). 새 탭에서 열립니다.`);
      window.open(url, '_blank', 'noopener');
    });

  const remove = (id: string) =>
    run(async () => {
      await endpoints.deleteFile(id);
      setSelected(null);
      await load();
      setMessage('삭제했습니다. 이 파일에 걸린 공유도 함께 정리됩니다.');
    });

  return (
    <Shell title="파일">
      <Banner error={error} message={message} />

      <div style={{ ...s.row, marginBottom: 8 }}>
        <span style={s.muted}>{total}개</span>
        {canReadAll && (
          <label style={{ ...s.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox" checked={adminView}
              onChange={(e) => { setAdminView(e.target.checked); setSelected(null); }}
            />
            전체 보기 (file.read.all)
          </label>
        )}
      </div>

      <Card>
        {items.length === 0 ? (
          <Empty>파일이 없습니다. 업로드는 API(서명 URL)로만 가능합니다.</Empty>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>이름</th>
                <th style={s.th}>크기</th>
                <th style={s.th}>형식</th>
                <th style={s.th}>관계</th>
                <th style={s.th}>등록</th>
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td style={s.td}>{f.name}</td>
                  <td style={s.td}>{(f.sizeBytes / 1024).toFixed(1)} KB</td>
                  <td style={s.td}>{f.mimeType}</td>
                  <td style={s.td}>
                    <span style={s.tag}>{f.relation === 'owner' ? '소유' : '공유받음'}</span>
                  </td>
                  <td style={s.td}>{new Date(f.createdAt).toLocaleDateString('ko-KR')}</td>
                  <td style={s.td}>
                    <div style={s.row}>
                      <button onClick={() => void select(f)} style={s.button} disabled={busy}>공유 관리</button>
                      <button onClick={() => void download(f.id)} style={s.button} disabled={busy}>다운로드</button>
                      <button onClick={() => void remove(f.id)} style={s.danger} disabled={busy}>삭제</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected && (
        <Card title={`공유 관리 — ${selected.name}`}>
          <p style={s.muted}>
            부여할 수 있는 권한은 §4.4 화이트리스트로 제한됩니다. <code>file.share</code> 는 목록에
            없어 <strong>재공유가 원천 차단</strong>됩니다.
          </p>

          <form onSubmit={share} style={{ ...s.form, marginBottom: 16 }}>
            <input
              placeholder="대상 사용자 ID (UUID)" value={subjectId} required
              onChange={(e) => setSubjectId(e.target.value)} style={s.input}
            />
            <select value={permission} onChange={(e) => setPermission(e.target.value)} style={s.input}>
              <option value="file.read">file.read — 조회·다운로드</option>
              <option value="file.update">file.update — 메타데이터 수정</option>
            </select>
            <button type="submit" style={s.button} disabled={busy}>공유</button>
          </form>

          {shares.length === 0 ? (
            <Empty>공유가 없습니다.</Empty>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>대상</th>
                  <th style={s.th}>권한</th>
                  <th style={s.th}>만료</th>
                  <th style={s.th} />
                </tr>
              </thead>
              <tbody>
                {shares.map((sh) => (
                  <tr key={sh.grantId}>
                    <td style={s.td}>{sh.subjectId}</td>
                    <td style={s.td}>{sh.permission}</td>
                    <td style={s.td}>
                      {sh.expiresAt ? new Date(sh.expiresAt).toLocaleString('ko-KR') : '없음'}
                    </td>
                    <td style={s.td}>
                      <button onClick={() => void revoke(sh.grantId)} style={s.danger} disabled={busy}>
                        회수
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </Shell>
  );
}
