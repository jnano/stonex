/**
 * Board Type 프리셋 (WP-B5, 스펙 §5).
 *
 * "특화 게시판"은 코드가 아니라 **설정 + 기능모듈 조합**이다. 프리셋은 그 조합의
 * 이름 붙은 기본값일 뿐이며, 생성 후 board.manage 가 개별 설정을 덮어쓸 수 있다.
 * 새 타입 추가 = 이 표에 행 추가 — 재배포 없는 확장이 §5 의 계약이다.
 *
 * settings 는 화이트리스트 스키마 검증을 통과해야 저장된다(§10.2 — 임의 키 금지).
 * write_policy 같은 값은 **정책 판정의 입력**이지 그 자체가 인가가 아니다(BINV-1) —
 * 최종 허용/거부는 언제나 can() + 정책 함수가 낸다.
 */

export interface BoardSettings {
  list_layout: 'LIST' | 'GALLERY' | 'CARD';
  write_policy: 'MEMBER' | 'MODERATOR';
  comment: { enabled: boolean; max_depth: number }; // 0 = 무제한
  editor: { markdown: boolean; attachments: boolean; max_attachments: number };
  paging: { size: number; mode: 'KEYSET' };
}

export interface BoardTypePreset {
  settings: BoardSettings;
  /** 생성 시 켜지는 기능모듈 — 목록에 없는 것은 꺼진 상태로 시작 */
  capabilitiesDefault: string[];
}

const BASE: BoardSettings = {
  list_layout: 'LIST',
  write_policy: 'MEMBER',
  comment: { enabled: true, max_depth: 3 },
  editor: { markdown: true, attachments: true, max_attachments: 10 },
  paging: { size: 20, mode: 'KEYSET' },
};

export const BOARD_TYPE_PRESETS: Record<string, BoardTypePreset> = {
  NOTICE: {
    settings: { ...BASE, write_policy: 'MODERATOR', comment: { enabled: true, max_depth: 1 } },
    capabilitiesDefault: ['attachment', 'notification'],
  },
  QNA: {
    settings: { ...BASE },
    // 비밀 질문(secret-post)은 QNA 의 흔한 요구 — 접근개입 모듈도 프리셋 조합의 일부다(§6.5)
    capabilitiesDefault: [
      'tag', 'reaction', 'attachment', 'notification', 'secret-post', 'mention', 'accepted-answer',
    ],
  },
  GALLERY: {
    settings: { ...BASE, list_layout: 'GALLERY' },
    capabilitiesDefault: ['attachment', 'reaction', 'notification', 'view-count'],
  },
  FORUM: {
    settings: { ...BASE, comment: { enabled: true, max_depth: 0 } },
    capabilitiesDefault: [
      'tag', 'reaction', 'attachment', 'report', 'notification', 'view-count',
      'secret-post', 'co-author', 'mention', 'user-block',
    ],
  },
  FAQ: {
    settings: { ...BASE, write_policy: 'MODERATOR', comment: { enabled: false, max_depth: 0 } },
    capabilitiesDefault: ['tag'],
  },
};

/** settings 화이트리스트 검증 — 임의 키·잘못된 값은 저장 전에 거부한다(§10.2) */
export function validateSettings(input: unknown): BoardSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const listLayouts = ['LIST', 'GALLERY', 'CARD'];
  const writePolicies = ['MEMBER', 'MODERATOR'];

  const knownKeys = new Set(['list_layout', 'write_policy', 'comment', 'editor', 'paging']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) throw new Error(`settings 에 허용되지 않은 키입니다: ${key}`);
  }
  const comment = (raw.comment ?? {}) as Record<string, unknown>;
  const editor = (raw.editor ?? {}) as Record<string, unknown>;
  const paging = (raw.paging ?? {}) as Record<string, unknown>;

  const settings: BoardSettings = {
    list_layout: listLayouts.includes(raw.list_layout as string)
      ? (raw.list_layout as BoardSettings['list_layout']) : BASE.list_layout,
    write_policy: writePolicies.includes(raw.write_policy as string)
      ? (raw.write_policy as BoardSettings['write_policy']) : BASE.write_policy,
    comment: {
      enabled: typeof comment.enabled === 'boolean' ? comment.enabled : BASE.comment.enabled,
      max_depth: clampInt(comment.max_depth, 0, 20, BASE.comment.max_depth),
    },
    editor: {
      markdown: typeof editor.markdown === 'boolean' ? editor.markdown : BASE.editor.markdown,
      attachments: typeof editor.attachments === 'boolean' ? editor.attachments : BASE.editor.attachments,
      max_attachments: clampInt(editor.max_attachments, 0, 50, BASE.editor.max_attachments),
    },
    paging: { size: clampInt(paging.size, 1, 100, BASE.paging.size), mode: 'KEYSET' },
  };
  return settings;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
