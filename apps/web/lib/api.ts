/**
 * API 클라이언트 (기획서 §3·§8.4).
 *
 * **표시 분기는 UX 목적이며 보안 경계가 아니다.** 모든 실제 통제는 백엔드가 수행하므로,
 * 이 클라이언트는 서버의 401/403/404 를 항상 그대로 전달해 화면이 처리하게 한다.
 * 프론트에서 권한 판단 로직을 재구현하는 것을 금지한다(중복 구현은 곧 불일치).
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
const ACCESS_TOKEN_KEY = 'stonex.accessToken';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 오류 표시 문구를 한 곳에서 만든다.
 *
 * 화면마다 `${e.message} (${e.status})` 를 손으로 조립하면, 메시지에 이미 코드가 든 경우
 * 중복 표기가 나고 화면마다 형식도 갈린다.
 */
export function errorText(e: unknown, fallback = '요청에 실패했습니다.'): string {
  if (e instanceof ApiError) return `${e.message} (${e.status})`;
  return fallback;
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setAccessToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
  else window.localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    // 401 은 pv 불일치(권한 회수)로도 발생한다 — 재로그인이 정상 흐름이다(§8.3)
    if (res.status === 401) setAccessToken(null);
    /**
     * 서버 오류 사유를 그대로 보여준다 — 프론트가 사유를 지어내지 않는다.
     *
     * NestJS 기본 예외 형태는 `{ message, error, statusCode }` 이고, message 는
     * 문자열이거나 (ValidationPipe) 문자열 배열이다. 기존 코드는 `error.message`
     * (중첩 객체)만 읽어 **모든 서버 사유가 통째로 삼켜지고 있었다** — 신고 400 이
     * "자기 글은 신고할 수 없습니다" 대신 "요청이 처리되지 않았습니다"로 보인 원인.
     * 형태가 바뀌어도 견디도록 두 모양을 모두 받는다.
     */
    const body = (await res.json().catch(() => ({}))) as {
      message?: string | string[];
      error?: string | { message?: string };
    };
    const nested = typeof body.error === 'object' ? body.error?.message : undefined;
    const direct = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    // 상태 코드는 메시지에 넣지 않는다 — 화면이 따로 붙이므로 넣으면 "(404) (404)" 가 된다
    throw new ApiError(res.status, nested ?? direct ?? '요청이 처리되지 않았습니다.');
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── 응답 타입 (백엔드 직렬화와 1:1) ──

export interface MeResponse {
  id: string;
  status: string;
  roles: string[];
  permissions: Array<{ code: string; scope: string }>;
}

export interface MemberSummary {
  id: string;
  email: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface MemberDetail extends MemberSummary {
  roles: string[];
  totpEnrolled: boolean;
  onboarding: { mustChangePassword: boolean; totpEnrollmentRequired: boolean };
}

export interface DominanceCheck {
  manageable: boolean;
  reason: string;
  missing: string[];
}

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  requires2fa: boolean;
  isSystem: boolean;
  holderCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissions: Array<{ code: string; scope: string; description: string }>;
}

export interface PermissionCatalogItem {
  code: string;
  scope: string;
  description: string;
  module: string;
  /** 행위자가 보유하여 부여 가능한지 — 표시 보조일 뿐, 실제 통제는 서버(§10.1) */
  assignable: boolean;
}

export interface OnboardingStatus {
  mustChangePassword: boolean;
  totpEnrollmentRequired: boolean;
}

export interface EmailChangeView {
  id: string;
  newEmail: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

// ── Phase 2 리소스 (파일·도메인) ──

export interface FileSummary {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
  /** 요청자와의 관계 — 표시 구분용 */
  relation: 'owner' | 'shared';
}

export interface ShareSummary {
  grantId: string;
  subjectId: string;
  permission: string;
  expiresAt: string | null;
  grantedBy: string;
  grantedAt: string;
}

export interface DomainSummary {
  id: string;
  fqdn: string;
  status: string;
  verifiedAt: string | null;
  createdAt: string;
  relation: 'owner' | 'shared';
  /** 미검증 상태에서만 내려온다 */
  verificationRecord: { name: string; value: string } | null;
}

export interface VerificationAttempt {
  id: string;
  state: string;
  reason: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TransferSummary {
  id: string;
  domainId: string;
  fqdn: string;
  fromUserId: string;
  toUserId: string;
  status: string;
  reason: string | null;
  expiresAt: string;
  createdAt: string;
}

// ── 거버넌스·감사 ──

export interface CheckStatusView {
  id: string;
  title: string;
  severity: string;
  /** 'unknown' = 판정 기록 없음. **'ok' 와 반드시 구분해 표시한다**(RT-20) */
  status: 'ok' | 'violated' | 'failed' | 'unavailable' | 'unknown';
  violations: number;
  error?: string;
}

export interface PatrolStatusView {
  healthy: boolean;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  hasFailedChecks: boolean;
  checks: CheckStatusView[];
  remediated: number;
  escalated: string[];
  unknownResourceTypes: string[];
}

export interface ActionView {
  at: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  before: { subject?: string; resourceType?: string; resourceId?: string; effect?: string } | null;
}

export interface FreezeSummary {
  id: string;
  userId: string;
  trigger: string;
  reason: string;
  status: string;
  frozenAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

export interface AnomalySignal {
  ruleId: string;
  tenantId: string;
  actorId: string;
  title: string;
  detail: Record<string, unknown>;
}

export interface AuditEntryView {
  id: string;
  at: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
}

export interface SimulationResult {
  allow: boolean;
  step: number;
  /** 사전 정의된 사유 코드뿐 — 평가기의 자유 텍스트는 응답에 실리지 않는다(WT-13) */
  reason: string;
  subjectId: string;
  permission: string;
  resource: { type: string; id: string } | null;
}

export interface ChangelogEntry {
  version: string;
  date: string | null;
  sections: Array<{ kind: string; items: string[] }>;
}

export interface ComponentState {
  label: string;
  status: 'ok' | 'mismatch' | 'unknown';
  detail: string;
}

export interface VersionView {
  version: string;
  commit: string | null;
  startedAt: string;
  components: ComponentState[];
  changelog: ChangelogEntry[];
}

export interface SettingFieldView {
  key: string;
  label: string;
  kind: string;
  hint?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  /** 평문 항목의 현재 값. **비밀 항목은 항상 null** — 서버가 내려주지 않는다 */
  value: string | null;
  configured: boolean;
}

export interface CategoryView {
  category: string;
  label: string;
  description: string;
  testable: boolean;
  fields: SettingFieldView[];
}

export interface TestResult {
  ok: boolean;
  message: string;
}


// ── board 모듈 기여 시작 (D-2, WP-B1) ──
export interface BoardSettings {
  list_layout: 'LIST' | 'GALLERY' | 'CARD';
  write_policy: 'MEMBER' | 'MODERATOR';
  comment: { enabled: boolean; max_depth: number };
  editor: { markdown: boolean; attachments: boolean; max_attachments: number };
  paging: { size: number; mode: 'KEYSET' };
}

export interface BoardSummary {
  id: string;
  slug: string;
  name: string;
  boardType: string;
  visibility: string;
  status: string;
  postCount: number;
  createdAt: string;
  /** 화면이 표현을 정하는 근거(§5) — 표시 분기의 입력일 뿐 인가가 아니다 */
  settings: BoardSettings;
  capabilities: string[];
}

export interface PostSummary {
  id: string;
  boardId: string;
  ownerId: string;
  title: string;
  isPinned: boolean;
  commentCount: number;
  viewCount: number;
  status: string;
  isSecret: boolean;
  createdAt: string;
  ownerName: string;
  /** 채택된 답변 댓글 id — null 이면 미해결(§B9) */
  acceptedCommentId: string | null;
}

export interface ReportView {
  id: string;
  postId: string;
  postTitle: string;
  reason: string;
  status: string;
  createdAt: string;
  openCountForPost: number;
}

export interface BriResult {
  id: string;
  title: string;
  violations: number;
  remediated: number;
}

export interface Attachment {
  fileId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  /** 표시·다운로드용 서명 URL (만료 있음) — 이미지는 inline, 그 외는 다운로드 */
  url?: string;
}

export interface PostDetail extends PostSummary {
  bodyHtml: string;
  bodyMd: string;
  updatedAt: string;
  attachments: Attachment[];
  tags: string[];
}

export interface CommentView {
  id: string;
  postId: string;
  ownerId: string;
  ownerName: string;
  parentId: string | null;
  depth: number;
  bodyHtml: string;
  /** 본인 댓글에만 실린다 — 수정 화면용 원본 */
  bodyMd?: string;
  status: string;
  createdAt: string;
  reactions: Array<{ kind: string; count: number; mine: boolean }>;
}
// ── board 모듈 기여 끝 ──

/**
 * 개발 전용 로그인 표시 조건 — `NEXT_PUBLIC_DEV_LOGIN=1` **명시**일 때만.
 *
 * 값이 빌드 시점에 인라인되므로, 이 변수 없이 빌드하면 버튼도 호출도 번들에 남지
 * 않는다. 서버 쪽 라우트도 별도 플래그를 요구하므로 **양쪽이 모두 켜져야** 동작한다.
 */
export const DEV_LOGIN_ENABLED = process.env.NEXT_PUBLIC_DEV_LOGIN === '1';

export const endpoints = {
  login: (email: string, password: string) =>
    api<{ accessToken: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => api<MeResponse>('/me'),
  /** 개발 전용 — 서버에도 DEV_LOGIN=1 이 있어야 라우트가 존재한다(없으면 404) */
  devLogin: (email: string) =>
    api<{ accessToken: string; refreshToken: string }>('/auth/dev/login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  // ── 온보딩(§8.5) — 미완료 세션은 이 경로들만 접근할 수 있다 ──
  onboardingStatus: () => api<OnboardingStatus>('/auth/onboarding/status'),
  onboardPassword: (password: string) =>
    api<{ ok: true }>('/auth/onboarding/password', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  onboardTotpBegin: () => api<{ keyUri: string }>('/auth/onboarding/totp', { method: 'POST' }),
  onboardTotpConfirm: (code: string) =>
    api<{ ok: true }>('/auth/onboarding/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  // ── MEM-1 이메일 변경 (재인증 + 새 주소 소유 확인) ──
  emailChangePending: () => api<EmailChangeView | null>('/members/me/email-change'),
  requestEmailChange: (newEmail: string, stepUp: { code?: string; password?: string }) =>
    api<EmailChangeView>('/members/me/email-change', {
      method: 'POST',
      body: JSON.stringify({ newEmail, ...stepUp }),
    }),
  cancelEmailChange: (id: string) =>
    api<{ ok: true }>(`/members/me/email-change/${id}`, { method: 'DELETE' }),
  confirmEmailChange: (token: string) =>
    api<{ ok: true }>('/members/email-change/confirm', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  members: (page = 1) => api<{ items: MemberSummary[]; total: number }>(`/members?page=${page}`),
  member: (id: string) => api<MemberDetail>(`/members/${id}`),
  manageable: (id: string) => api<DominanceCheck>(`/members/${id}/manageable`),
  ban: (id: string) => api<MemberDetail>(`/members/${id}/ban`, { method: 'POST' }),
  unban: (id: string) => api<MemberDetail>(`/members/${id}/unban`, { method: 'POST' }),
  // ── 파일 (FILE-1~7) ──
  // ── board 모듈 기여 (D-2, WP-B1) ──
  boards: (page = 1) => api<{ items: BoardSummary[]; total: number }>(`/boards?page=${page}`),
  board: (id: string) => api<BoardSummary>(`/boards/${id}`),
  boardPosts: (boardId: string, options: { cursor?: string; unansweredOnly?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (options.cursor) q.set('cursor', options.cursor);
    if (options.unansweredOnly) q.set('unanswered', '1');
    const qs = q.toString();
    return api<{ items: PostSummary[]; nextCursor: string | null }>(
      `/boards/${boardId}/posts${qs ? `?${qs}` : ''}`,
    );
  },
  post: (id: string) => api<PostDetail>(`/posts/${id}`),
  searchPosts: (boardId: string, q: string) =>
    api<PostSummary[]>(`/boards/${boardId}/search?q=${encodeURIComponent(q)}`),
  postComments: (id: string) => api<CommentView[]>(`/posts/${id}/comments`),
  createPost: (boardId: string, body: { title: string; bodyMd: string; attachmentFileIds?: string[] }) =>
    api<PostDetail>(`/boards/${boardId}/posts`, { method: 'POST', body: JSON.stringify(body) }),
  updatePost: (id: string, body: { title?: string; bodyMd?: string; attachmentFileIds?: string[] }) =>
    api<PostDetail>(`/posts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  issueBoardUpload: (boardId: string, body: { contentType: string; contentLength: number }) =>
    api<{ uploadId: string; uploadUrl: string; expiresAt: string }>(`/boards/${boardId}/uploads`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  completeBoardUpload: (body: { uploadId: string; checksum: string; name: string }) =>
    api<Attachment>('/boards/attachments/complete', { method: 'POST', body: JSON.stringify(body) }),
  createComment: (postId: string, body: { bodyMd: string; parentId?: string }) =>
    api<CommentView>(`/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify(body) }),
  toggleReaction: (postId: string, kind: string) =>
    api<{ added: boolean }>(`/posts/${postId}/reactions`, { method: 'POST', body: JSON.stringify({ kind }) }),
  reactions: (postId: string) =>
    api<Array<{ kind: string; count: number; mine: boolean }>>(`/posts/${postId}/reactions`),
  notifications: (unreadOnly = false) =>
    api<Array<{ id: string; kind: string; payload: { boardId?: string; postId?: string }; createdAt: string; readAt: string | null }>>(
      `/notifications${unreadOnly ? '?unread=1' : ''}`,
    ),
  markNotificationRead: (id: string) =>
    api<{ ok: true }>(`/notifications/${id}/read`, { method: 'POST' }),
  createBoard: (body: { slug: string; name: string; boardType?: string; visibility?: string }) =>
    api<BoardSummary>('/boards', { method: 'POST', body: JSON.stringify(body) }),
  boardCapabilities: (boardId: string) =>
    api<Array<{ key: string; enabled: boolean }>>(`/boards/${boardId}/capabilities`),
  setBoardCapability: (boardId: string, key: string, enabled: boolean) =>
    api<{ ok: true }>(`/boards/${boardId}/capabilities`, {
      method: 'PATCH', body: JSON.stringify({ key, enabled }),
    }),
  reportPost: (postId: string, reason: string) =>
    api<{ ok: true }>(`/posts/${postId}/report`, { method: 'POST', body: JSON.stringify({ reason }) }),
  boardReports: () => api<ReportView[]>('/admin/board/reports'),
  resolveReport: (id: string, uphold: boolean) =>
    api<{ ok: true }>(`/admin/board/reports/${id}/resolve`, {
      method: 'POST', body: JSON.stringify({ uphold }),
    }),
  boardPatrol: () => api<BriResult[]>('/admin/board/patrol'),
  createMember: (body: { email: string; name: string; roleIds?: string[] }) =>
    api<{ member: { id: string; email: string }; temporaryPassword: string }>('/members', {
      method: 'POST', body: JSON.stringify(body),
    }),
  acceptAnswer: (postId: string, commentId: string) =>
    api<PostDetail>(`/posts/${postId}/accept`, { method: 'POST', body: JSON.stringify({ commentId }) }),
  deletePost: (id: string) => api<{ ok: true }>(`/posts/${id}`, { method: 'DELETE' }),
  updateComment: (id: string, bodyMd: string) =>
    api<CommentView>(`/comments/${id}`, { method: 'PATCH', body: JSON.stringify({ bodyMd }) }),
  deleteComment: (id: string) => api<{ ok: true }>(`/comments/${id}`, { method: 'DELETE' }),
  toggleCommentReaction: (id: string, kind: string) =>
    api<{ added: boolean }>(`/comments/${id}/reactions`, { method: 'POST', body: JSON.stringify({ kind }) }),
  /** 운영 행위 — 게시판 위임(board.moderate) 경로 */
  moderatePost: (id: string, body: { pin?: boolean; hide?: boolean; moveToBoardId?: string }) =>
    api<PostSummary>(`/posts/${id}/moderate`, { method: 'POST', body: JSON.stringify(body) }),
  /** 운영 행위 — 전체 권한(board.moderate.all) 경로. 라우트 분리(§7.3) */
  moderatePostAsAdmin: (id: string, body: { pin?: boolean; hide?: boolean; moveToBoardId?: string }) =>
    api<PostSummary>(`/admin/board/posts/${id}/moderate`, { method: 'POST', body: JSON.stringify(body) }),

  files: (page = 1) => api<{ items: FileSummary[]; total: number }>(`/files?page=${page}`),
  file: (id: string) => api<FileSummary>(`/files/${id}`),
  renameFile: (id: string, name: string) =>
    api<FileSummary>(`/files/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteFile: (id: string) => api<{ ok: true }>(`/files/${id}`, { method: 'DELETE' }),
  downloadUrl: (id: string) =>
    api<{ url: string; expiresInSeconds: number }>(`/files/${id}/download-url`),
  fileShares: (id: string) => api<ShareSummary[]>(`/files/${id}/shares`),
  createFileShare: (id: string, subjectId: string, permissions: string[], expiresAt?: string) =>
    api<ShareSummary[]>(`/files/${id}/shares`, {
      method: 'POST',
      body: JSON.stringify({ subjectId, permissions, ...(expiresAt ? { expiresAt } : {}) }),
    }),
  revokeFileShare: (id: string, grantId: string) =>
    api<{ ok: true }>(`/files/${id}/shares/${grantId}`, { method: 'DELETE' }),
  allFiles: (page = 1) => api<{ items: FileSummary[]; total: number }>(`/admin/files?page=${page}`),

  // ── 도메인 (DOM-1~7) ──
  domains: (page = 1) => api<{ items: DomainSummary[]; total: number }>(`/domains?page=${page}`),
  createDomain: (fqdn: string) =>
    api<DomainSummary>('/domains', { method: 'POST', body: JSON.stringify({ fqdn }) }),
  domain: (id: string) => api<DomainSummary>(`/domains/${id}`),
  updateDomain: (id: string, fqdn: string) =>
    api<DomainSummary>(`/domains/${id}`, { method: 'PATCH', body: JSON.stringify({ fqdn }) }),
  deleteDomain: (id: string) => api<{ ok: true }>(`/domains/${id}`, { method: 'DELETE' }),
  verifyDomain: (id: string) =>
    api<{ attemptId: string; state: string }>(`/domains/${id}/verify`, { method: 'POST' }),
  verificationHistory: (id: string) => api<VerificationAttempt[]>(`/domains/${id}/verification`),
  delegations: (id: string) => api<ShareSummary[]>(`/domains/${id}/delegations`),
  createDelegation: (id: string, subjectId: string, permissions: string[]) =>
    api<ShareSummary[]>(`/domains/${id}/delegations`, {
      method: 'POST',
      body: JSON.stringify({ subjectId, permissions }),
    }),
  revokeDelegation: (id: string, grantId: string) =>
    api<{ ok: true }>(`/domains/${id}/delegations/${grantId}`, { method: 'DELETE' }),
  proposeTransfer: (id: string, toUserId: string) =>
    api<TransferSummary>(`/domains/${id}/transfers`, {
      method: 'POST',
      body: JSON.stringify({ toUserId }),
    }),
  cancelTransfer: (domainId: string, transferId: string) =>
    api<{ ok: true }>(`/domains/${domainId}/transfers/${transferId}`, { method: 'DELETE' }),
  myTransfers: () => api<TransferSummary[]>('/transfers'),
  acceptTransfer: (id: string) =>
    api<TransferSummary>(`/transfers/${id}/accept`, { method: 'POST' }),

  // ── 거버넌스 (§14) ──
  patrolStatus: () => api<PatrolStatusView>('/admin/governance/status'),
  governanceActions: (limit = 50) => api<ActionView[]>(`/admin/governance/actions?limit=${limit}`),
  freezes: (includeReleased = false) =>
    api<FreezeSummary[]>(`/admin/governance/freezes?includeReleased=${includeReleased}`),
  releaseFreeze: (id: string, note?: string) =>
    api<FreezeSummary>(`/admin/governance/freezes/${id}/release`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  anomalies: (hours = 24) => api<AnomalySignal[]>(`/admin/governance/anomalies?hours=${hours}`),

  // ── 시스템 설정 (system.settings.manage) ──
  settings: () =>
    api<{ categories: CategoryView[]; encryptionKeyConfigured: boolean }>('/admin/settings'),
  updateSettings: (category: string, values: Record<string, string>) =>
    api<CategoryView[]>(`/admin/settings/${category}`, {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),
  testSettings: (category: string) =>
    api<TestResult>(`/admin/settings/${category}/test`, { method: 'POST' }),

  // ── 버전·시스템 상태 ──
  version: () => api<VersionView>('/admin/version'),

  // ── ADM-4·5 ──
  auditLogs: (params: {
    from: string; to: string; actorId?: string; action?: string;
    targetType?: string; targetId?: string; page?: number; size?: number;
  }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    return api<{ items: AuditEntryView[]; total: number }>(`/admin/audit-logs?${q.toString()}`);
  },
  simulate: (input: {
    subjectId: string; permission: string; resourceType?: string; resourceId?: string;
  }) => api<SimulationResult>('/admin/simulate', { method: 'POST', body: JSON.stringify(input) }),

  roles: () => api<RoleSummary[]>('/admin/roles'),
  role: (id: string) => api<RoleDetail>(`/admin/roles/${id}`),
  permissionCatalog: () => api<PermissionCatalogItem[]>('/admin/roles/permissions'),
  setRolePermissions: (id: string, codes: string[]) =>
    api<RoleDetail>(`/admin/roles/${id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ codes }),
    }),
};
