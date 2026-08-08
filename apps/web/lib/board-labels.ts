/**
 * 게시판 표시 라벨 (board 모듈 기여 — D-2).
 *
 * **표시 전용이다** — 저장 값·API 계약은 영문 코드 그대로이고, 화면에 보일 때만
 * 여기서 번역한다. 두 곳에서 각자 번역하면 언젠가 갈라지므로(§15.1) 단일 출처로 모은다.
 * 서버에 새 키가 생겨 맵에 없으면 코드가 그대로 보인다 — 조용히 숨기지 않는다.
 */

export const BOARD_TYPE_LABELS: Record<string, string> = {
  FORUM: '포럼',
  NOTICE: '공지',
  QNA: '질문답변',
  GALLERY: '갤러리',
  FAQ: '자주 묻는 질문',
};

export const VISIBILITY_LABELS: Record<string, string> = {
  PUBLIC: '공개',
  RESTRICTED: '제한',
  PRIVATE: '비공개',
};

export const CAPABILITY_LABELS: Record<string, string> = {
  attachment: '첨부',
  reaction: '반응',
  tag: '태그',
  notification: '알림',
  'view-count': '조회수',
  report: '신고',
  'secret-post': '비밀글',
  'co-author': '공동작성',
  'user-block': '사용자 차단',
  mention: '멘션',
};

export const boardTypeLabel = (code: string): string => BOARD_TYPE_LABELS[code] ?? code;
export const visibilityLabel = (code: string): string => VISIBILITY_LABELS[code] ?? code;
export const capabilityLabel = (code: string): string => CAPABILITY_LABELS[code] ?? code;
