/**
 * 파일 응답 직렬화 (기획서 §10.2) — **화이트리스트 방식**.
 *
 * `storage_key` 는 어떤 경로로도 노출하지 않는다(WP-9 DoD). 블랙리스트 방식으로 짜면
 * 컬럼이 추가될 때 자동으로 새어 나가므로, 내보낼 필드를 여기 명시적으로 나열한다.
 */

export interface FileSummary {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
  /** 이 파일에 대한 요청자의 관계 — 목록 UI 가 소유/공유를 구분하는 데 쓴다 */
  relation: 'owner' | 'shared';
}

interface FileRow {
  id: string;
  name: string;
  size_bytes: bigint;
  mime_type: string;
  created_at: Date;
  owner_id: string;
}

export function toFileSummary(file: FileRow, viewerId: string): FileSummary {
  return {
    id: file.id,
    name: file.name,
    sizeBytes: Number(file.size_bytes),
    mimeType: file.mime_type,
    createdAt: file.created_at.toISOString(),
    relation: file.owner_id === viewerId ? 'owner' : 'shared',
  };
}
