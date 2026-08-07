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

export const endpoints = {
  login: (email: string, password: string) =>
    api<{ accessToken: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => api<MeResponse>('/me'),
  members: (page = 1) => api<{ items: MemberSummary[]; total: number }>(`/members?page=${page}`),
  member: (id: string) => api<MemberDetail>(`/members/${id}`),
  manageable: (id: string) => api<DominanceCheck>(`/members/${id}/manageable`),
  ban: (id: string) => api<MemberDetail>(`/members/${id}/ban`, { method: 'POST' }),
  unban: (id: string) => api<MemberDetail>(`/members/${id}/unban`, { method: 'POST' }),
  roles: () => api<RoleSummary[]>('/admin/roles'),
  role: (id: string) => api<RoleDetail>(`/admin/roles/${id}`),
  permissionCatalog: () => api<PermissionCatalogItem[]>('/admin/roles/permissions'),
  setRolePermissions: (id: string, codes: string[]) =>
    api<RoleDetail>(`/admin/roles/${id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ codes }),
    }),
};
