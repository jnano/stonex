import MarkdownIt from 'markdown-it';
import { FilterXSS } from 'xss';

/**
 * 마크다운 파이프라인 (WP-B2, 스펙 §7.1).
 *
 * `body_md`(원본 정본) → 서버 렌더 → **렌더 시점 서버 새니타이즈** → `body_html` 캐시.
 *
 * 방어를 렌더 시점에 고정하는 이유(R-B2): 저장 시점 필터만 하면 렌더러·설정이 바뀔 때
 * 과거 저장분이 우회 경로가 된다. 원본에 위험 문자열이 있어도 **저장은 하되 렌더에서
 * 무력화**한다 — 원본 보존과 안전 표시를 분리한다. 표시 경로는 언제나 body_html 만
 * 사용하며, body_md 를 프론트에서 직접 렌더하는 것은 G-2 가 정적으로 차단한다.
 */

// html:false — 마크다운 안의 생 HTML 은 렌더 단계에서 이미 텍스트로 이스케이프된다.
// 새니타이저는 그 위의 2차 방어선이다(렌더러 결함·설정 변경 대비 이중화).
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const URL_ATTRS = new Set(['href', 'src']);
const SAFE_URL = /^https?:\/\//i;

const sanitizer = new FilterXSS({
  whiteList: {
    p: [], br: [], strong: [], em: [], s: [], hr: [],
    code: ['class'], pre: [], blockquote: [],
    ul: [], ol: [], li: [],
    h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
    a: ['href', 'title', 'target'],
    img: ['src', 'alt', 'title'],
    table: [], thead: [], tbody: [], tr: [], th: ['align'], td: ['align'],
  },
  // 화이트리스트 밖 태그는 통째로 제거(내용 유지) — 이벤트 핸들러(on*)는 속성
  // 화이트리스트에 없으므로 전부 떨어진다
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
  onTagAttr: (tag, name, value) => {
    // javascript: · data: 등 비 http(s) 스킴 차단 — 링크·이미지는 절대 URL 만
    if (URL_ATTRS.has(name) && !SAFE_URL.test(value)) return '';
    return undefined; // 기본 처리(화이트리스트 검사)로
  },
});

export function renderBodyHtml(markdown: string): string {
  return sanitizer.process(md.render(markdown));
}

/** 자식 있는 댓글 삭제 시 트리 보존용 tombstone (§4.1, BINV-4) */
export const COMMENT_TOMBSTONE = '<p class="tombstone">삭제된 댓글입니다</p>';
