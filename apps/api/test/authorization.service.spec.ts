/**
 * 평가기 표 기반(table-driven) 단위 테스트 — WP-3 DoD.
 * 기획서 §4.8 전 사례 + 경계 사례. Grant 는 인메모리 스토어로 주입한다
 * (실 DB 경로는 grant-paths.integration.spec.ts 가 검증).
 */
import { testRegistry } from './helpers/registry';
import { AuthorizationService } from '../src/authorization/authorization.service';
import { GrantStore, PermissionScope, ResourceRef, SubjectSnapshot } from '../src/authorization/types';

type GrantRow = { effect: 'ALLOW' | 'DENY'; expiresAt: Date | null };

class InMemoryGrantStore implements GrantStore {
  constructor(private readonly rows: Record<string, GrantRow[]> = {}) {}
  async findGrants(subjectId: string, resourceType: string, resourceId: string, code: string) {
    return this.rows[`${subjectId}|${resourceType}|${resourceId}|${code}`] ?? [];
  }
}

const subject = (
  perms: Array<[string, PermissionScope]>,
  status = 'ACTIVE',
  id = 'user-1',
): SubjectSnapshot => ({
  id,
  tenantId: 't0',
  status,
  permVersion: 1,
  roles: [],
  permissions: new Map(perms),
});

const MEMBER_PERMS: Array<[string, PermissionScope]> = [
  ['file.read', 'owned'], ['file.upload', 'global'], ['file.update', 'owned'],
  ['file.delete', 'owned'], ['file.share', 'owned'], ['domain.read', 'owned'],
];
const FM_PERMS: Array<[string, PermissionScope]> = [...MEMBER_PERMS, ['file.read.all', 'global'], ['file.delete.all', 'global']];

const file = (ownerId: string, status = 'ACTIVE', id = 'file-1'): ResourceRef =>
  ({ type: 'file', id, ownerId, status, tenantId: 't0' });
const domain = (ownerId: string, status: string, id = 'dom-1'): ResourceRef =>
  ({ type: 'domain', id, ownerId, status, tenantId: 't0' });

const FUTURE = new Date(Date.now() + 3_600_000);
const PAST = new Date(Date.now() - 3_600_000);

describe('AuthorizationService.can — §4.8 표 사례', () => {
  const svc = (rows?: Record<string, GrantRow[]>) => new AuthorizationService(new InMemoryGrantStore(rows), testRegistry());

  const cases: Array<{
    name: string;
    rows?: Record<string, GrantRow[]>;
    subject: SubjectSnapshot;
    permission: string;
    resource?: ResourceRef;
    allow: boolean;
    step: number;
  }> = [
    { name: 'MEMBER가 자신이 올린 파일 삭제 → ALLOW(3)', subject: subject(MEMBER_PERMS), permission: 'file.delete', resource: file('user-1'), allow: true, step: 3 },
    { name: 'MEMBER가 타인 파일 열람 → DENY(5)', subject: subject(MEMBER_PERMS), permission: 'file.read', resource: file('user-2'), allow: false, step: 5 },
    { name: '공유받은(Grant file.read) 타인 파일 열람 → ALLOW(4)', rows: { 'user-1|file|file-1|file.read': [{ effect: 'ALLOW', expiresAt: FUTURE }] }, subject: subject(MEMBER_PERMS), permission: 'file.read', resource: file('user-2'), allow: true, step: 4 },
    { name: 'FILE_MANAGER가 타인 파일 열람(read.all) → ALLOW(3)', subject: subject(FM_PERMS), permission: 'file.read.all', resource: file('user-2'), allow: true, step: 3 },
    { name: 'FILE_MANAGER가 회원 정지 시도(member.ban 미보유) → DENY(5)', subject: subject(FM_PERMS), permission: 'member.ban', allow: false, step: 5 },
    { name: '소프트 삭제된 자기 파일 다운로드 → DENY(1)', subject: subject(MEMBER_PERMS), permission: 'file.read', resource: file('user-1', 'DELETED'), allow: false, step: 1 },
    { name: '정지된 계정의 모든 요청 → DENY(0)', subject: subject(MEMBER_PERMS, 'SUSPENDED'), permission: 'file.read', resource: file('user-1'), allow: false, step: 0 },
    // ── 경계 사례 ──
    { name: 'PENDING(미인증) 계정 → DENY(0)', subject: subject(MEMBER_PERMS, 'PENDING'), permission: 'file.upload', allow: false, step: 0 },
    { name: '만료된 ALLOW Grant → DENY(5)', rows: { 'user-1|file|file-1|file.read': [{ effect: 'ALLOW', expiresAt: PAST }] }, subject: subject(MEMBER_PERMS), permission: 'file.read', resource: file('user-2'), allow: false, step: 5 },
    { name: 'DENY Grant는 전역 권한(role global)보다 우선 → DENY(2, INV-4)', rows: { 'user-1|file|file-1|file.read.all': [{ effect: 'DENY', expiresAt: null }] }, subject: subject(FM_PERMS), permission: 'file.read.all', resource: file('user-2'), allow: false, step: 2 },
    { name: '만료된 DENY Grant는 차단하지 않음 → ALLOW(3)', rows: { 'user-1|file|file-1|file.read.all': [{ effect: 'DENY', expiresAt: PAST }] }, subject: subject(FM_PERMS), permission: 'file.read.all', resource: file('user-2'), allow: true, step: 3 },
    { name: 'SUSPENDED 도메인 조회(readExtra)는 소유자에게 허용 → ALLOW(3)', subject: subject([['domain.read', 'owned']]), permission: 'domain.read', resource: domain('user-1', 'SUSPENDED'), allow: true, step: 3 },
    { name: 'SUSPENDED 도메인 수정은 소유자도 불가 → DENY(1)', subject: subject([['domain.update', 'owned']]), permission: 'domain.update', resource: domain('user-1', 'SUSPENDED'), allow: false, step: 1 },
    { name: 'owned 권한을 리소스 없이 평가 → DENY(5)', subject: subject(MEMBER_PERMS), permission: 'file.read', allow: false, step: 5 },
    { name: '미등록 리소스 타입 → DENY(1, Default Deny 정신)', subject: subject([['x.read', 'global']]), permission: 'x.read', resource: { type: 'unknown', id: 'r', ownerId: 'user-1', status: 'ACTIVE', tenantId: 't0' }, allow: false, step: 1 },
  ];

  it.each(cases)('$name', async (c) => {
    const decision = await svc(c.rows).can(c.subject, c.permission, c.resource);
    expect({ allow: decision.allow, step: decision.step }).toEqual({ allow: c.allow, step: c.step });
  });
});
