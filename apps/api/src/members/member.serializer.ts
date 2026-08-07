/**
 * 회원 응답 직렬화 (기획서 §10.2).
 *
 * **화이트리스트 방식**: 내보낼 필드를 여기 명시적으로 나열한다.
 * 블랙리스트(민감 필드 제거) 방식은 컬럼이 추가될 때 자동으로 새어 나가므로 금지한다 —
 * password_hash·totp_secret 같은 필드는 애초에 이 함수를 통과할 수 없어야 한다.
 */

export interface MemberSummary {
  id: string;
  email: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface MemberDetail extends MemberSummary {
  roles: string[];
  /** 2FA 등록 여부 (시크릿 자체는 절대 노출하지 않는다) */
  totpEnrolled: boolean;
  onboarding: { mustChangePassword: boolean; totpEnrollmentRequired: boolean };
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
  created_at: Date;
}

interface UserDetailRow extends UserRow {
  totp_secret: string | null;
  must_change_password: boolean;
  totp_enrollment_required: boolean;
}

export function toMemberSummary(user: UserRow): MemberSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    createdAt: user.created_at.toISOString(),
  };
}

export function toMemberDetail(user: UserDetailRow, roles: string[]): MemberDetail {
  return {
    ...toMemberSummary(user),
    roles,
    totpEnrolled: user.totp_secret !== null,
    onboarding: {
      mustChangePassword: user.must_change_password,
      totpEnrollmentRequired: user.totp_enrollment_required,
    },
  };
}
