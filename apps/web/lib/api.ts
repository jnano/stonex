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
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(res.status, body.error?.message ?? `요청 실패 (${res.status})`);
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

export const endpoints = {
  login: (email: string, password: string) =>
    api<{ accessToken: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => api<MeResponse>('/me'),

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
