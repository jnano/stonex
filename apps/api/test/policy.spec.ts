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
  const context = { ownerId: 'owner', grantedBy: 'admin' };

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
