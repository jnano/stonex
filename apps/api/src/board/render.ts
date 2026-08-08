/**
 * 본문 렌더 (WP-B1 잠정판).
 *
 * WP-B2 가 마크다운 파이프라인(§7.1 — 서버 렌더 + 새니타이즈)을 넣기 전까지,
 * **전량 이스케이프 + 줄바꿈**만 한다. 원본(body_md)은 보존되므로 B2 도입 시
 * body_html 만 재생성하면 된다. 표시는 언제나 body_html — 프론트 직접 렌더 금지(G-2).
 */
const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function renderBodyHtml(md: string): string {
  const escaped = md.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
  return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
}

/** 자식 있는 댓글 삭제 시 트리 보존용 tombstone (§4.1, BINV-4) */
export const COMMENT_TOMBSTONE = '<p class="tombstone">삭제된 댓글입니다</p>';
