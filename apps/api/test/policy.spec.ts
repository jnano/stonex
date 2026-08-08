/**
 * PolicyService 단위 테스트.
 *
 * 기획서 §14.5-1이 명시했듯 **정책 함수 내부의 논리 버그는 G-1 매트릭스로 드러나지 않는다** —
 * 매트릭스는 역할 단위 판정만 담고, 관계 조건은 셀 하나에 접히기 때문이다.
 * 그래서 정책 함수는 모든 분기를 덮는 단위 테스트를 반드시 동반한다.
 */
import { PolicyService } from '../src/authorization/policy.service';
import { PermissionScope, SubjectSnapshot } from '../src/authorization/types';

const subject = (id: string, perms: Array<[string, PermissionScope]> = []): SubjectSnapshot => ({
  id, tenantId: 't0', status: 'ACTIVE', permVersion: 1, roles: [], permissions: new Map(perms),
});

describe('PolicyService.canRevokeShare (FILE-5)', () => {
  const policy = new PolicyService();
  const context = { resourceType: 'file', ownerId: 'owner', grantedBy: 'admin' };

  it('소유자는 타인이 만든 공유도 회수할 수 있다', () => {
    expect(policy.canRevokeShare(subject('owner'), context)).toEqual({ allowed: true, reason: 'OWNER' });
  });

  it('공유 생성자는 자기가 만든 공유를 회수할 수 있다', () => {
    expect(policy.canRevokeShare(subject('admin'), context)).toEqual({ allowed: true, reason: 'GRANTOR' });
  });

  it('file.share.all 보유자는 회수할 수 있다 — 소유자 계정이 정지돼도 유출 공유를 끊을 경로가 필요하다', () => {
    const admin = subject('other', [['file.share.all', 'global']]);
    expect(policy.canRevokeShare(admin, context)).toEqual({ allowed: true, reason: 'ADMIN' });
  });

  it('제3자는 거부된다', () => {
    expect(policy.canRevokeShare(subject('stranger'), context)).toEqual({
      allowed: false, reason: 'NOT_RELATED',
    });
  });

  it('공유 수령자라는 사실만으로는 회수할 수 없다', () => {
    // 수령자는 file.read Grant 를 갖지만 관계 조건 어디에도 해당하지 않는다
    const grantee = subject('grantee', [['file.read', 'owned']]);
    expect(policy.canRevokeShare(grantee, context).allowed).toBe(false);
  });
});

describe('PolicyService.canRevokeShare — 리소스 타입 일반화 (WP-13)', () => {
  const policy = new PolicyService();

  it('관리자 코드는 리소스 타입에서 도출된다', () => {
    const domainAdmin = subject('other', [['domain.share.all', 'global']]);
    const context = { resourceType: 'domain', ownerId: 'owner', grantedBy: 'admin' };
    expect(policy.canRevokeShare(domainAdmin, context)).toEqual({ allowed: true, reason: 'ADMIN' });
  });

  it('다른 타입의 share.all 은 통하지 않는다 (file 관리자가 도메인 위임을 끊을 수 없다)', () => {
    const fileAdmin = subject('other', [['file.share.all', 'global']]);
    const context = { resourceType: 'domain', ownerId: 'owner', grantedBy: 'admin' };
    expect(policy.canRevokeShare(fileAdmin, context).allowed).toBe(false);
  });
});

describe('PolicyService.canAcceptTransfer (DOM-6)', () => {
  const policy = new PolicyService();
  const now = new Date('2026-01-01T00:00:00Z');
  const base = {
    toUserId: 'recipient',
    transferStatus: 'PENDING',
    expiresAt: new Date('2026-01-08T00:00:00Z'),
    proposerId: 'owner',
    proposerStatus: 'ACTIVE',
    domainOwnerId: 'owner',
    domainStatus: 'VERIFIED',
    recipientDenied: false,
    now,
  };

  it('수령자 본인 + 유효 발의 + 소유자 일치 + 활성 상태면 수락된다', () => {
    expect(policy.canAcceptTransfer(subject('recipient'), base))
      .toEqual({ allowed: true, reason: 'OK' });
  });

  it('수령자가 아니면 거부된다 (발의자 본인 포함)', () => {
    expect(policy.canAcceptTransfer(subject('owner'), base).reason).toBe('NOT_RECIPIENT');
    expect(policy.canAcceptTransfer(subject('stranger'), base).reason).toBe('NOT_RECIPIENT');
  });

  it('이미 종료된 발의는 거부된다', () => {
    for (const status of ['ACCEPTED', 'CANCELLED', 'EXPIRED', 'INVALIDATED']) {
      expect(policy.canAcceptTransfer(subject('recipient'), { ...base, transferStatus: status }).reason)
        .toBe('NOT_PENDING');
    }
  });

  it('만료된 발의는 거부된다 (경계: 만료 시각 정각도 거부)', () => {
    expect(policy.canAcceptTransfer(subject('recipient'), { ...base, expiresAt: now }).reason)
      .toBe('EXPIRED');
  });

  it('발의자가 더 이상 소유자가 아니면 거부된다 (발의 후 재이전)', () => {
    expect(policy.canAcceptTransfer(subject('recipient'), { ...base, domainOwnerId: 'someone-else' }).reason)
      .toBe('PROPOSER_NOT_OWNER');
  });

  it('발의자가 비활성이면 거부된다', () => {
    for (const status of ['SUSPENDED', 'DELETED', 'PENDING']) {
      expect(policy.canAcceptTransfer(subject('recipient'), { ...base, proposerStatus: status }).reason)
        .toBe('PROPOSER_INACTIVE');
    }
  });

  it('이전 허용 상태(UNVERIFIED·VERIFIED) 밖이면 거부된다', () => {
    expect(policy.canAcceptTransfer(subject('recipient'), { ...base, domainStatus: 'UNVERIFIED' }).allowed)
      .toBe(true);
    for (const status of ['SUSPENDED', 'DELETED']) {
      expect(policy.canAcceptTransfer(subject('recipient'), { ...base, domainStatus: status }).reason)
        .toBe('DOMAIN_STATE');
    }
  });

  it('수령자에게 DENY 가 걸려 있으면 거부된다', () => {
    expect(policy.canAcceptTransfer(subject('recipient'), { ...base, recipientDenied: true }).reason)
      .toBe('RECIPIENT_DENIED');
  });
});
