import { Injectable } from '@nestjs/common';
import { SubjectSnapshot } from './types';

export interface ShareContext {
  /** 리소스 타입 — 관리자 코드(`{type}.share.all`)를 여기서 도출한다 */
  resourceType: string;
  /** 공유 대상 리소스의 소유자 */
  ownerId: string;
  /** 이 Grant 를 만든 사람 */
  grantedBy: string;
}

export interface PolicyResult {
  allowed: boolean;
  reason: 'OWNER' | 'GRANTOR' | 'ADMIN' | 'NOT_RELATED';
}

/** DOM-6 수락 시 재검증에 필요한 상태 — 모두 **잠근 뒤 읽은 값**이어야 한다 */
export interface TransferContext {
  toUserId: string;
  transferStatus: string;
  expiresAt: Date;
  /** 발의 시점의 소유자(= 발의자) */
  proposerId: string;
  proposerStatus: string;
  /** 현재 도메인 상태 */
  domainOwnerId: string;
  domainStatus: string;
  /** 수령자에게 이 도메인에 대한 유효한 DENY Grant 가 있는가 */
  recipientDenied: boolean;
  now: Date;
}

export type TransferReason =
  | 'OK'
  | 'NOT_RECIPIENT'
  | 'NOT_PENDING'
  | 'EXPIRED'
  | 'PROPOSER_NOT_OWNER'
  | 'PROPOSER_INACTIVE'
  | 'DOMAIN_STATE'
  | 'RECIPIENT_DENIED';

export interface TransferPolicyResult {
  allowed: boolean;
  reason: TransferReason;
}

/** 이전이 허용되는 도메인 상태 (기획서 DOM-6) */
const TRANSFERABLE_STATUSES = ['UNVERIFIED', 'VERIFIED'];

/**
 * 관계형 2차 인가 (기획서 §7.3).
 *
 * "소유자 또는 공유 생성자"(FILE-5)처럼 **단일 Permission 코드로 환원되지 않는 조건**은
 * 반드시 여기 **명명된 함수**로 둔다. 핸들러에 임의 구현하는 것을 금지하는 이유는
 * 감사와 권한 시뮬레이터(ADM-5)가 같은 로직을 재사용해야 하기 때문이다.
 * 각 함수의 규칙은 기능 명세(§6)의 해당 항목을 유일한 출처로 삼는다.
 *
 * 주의(§14.5-1): 정책 함수 내부의 논리 버그는 매트릭스로 드러나지 않는다.
 * 그래서 각 함수는 **모든 분기를 덮는 단위 테스트**를 반드시 동반한다.
 */
@Injectable()
export class PolicyService {
  /**
   * 공유·위임 회수 (FILE-5 / DOM-5): **소유자 본인 또는 Grant 생성자**.
   * 여기에 `{type}.share.all` 보유자(관리자)를 더한다 — 계정이 탈취·정지되면 소유자도 생성자도
   * 회수할 수 없어, 유출된 공유를 끊을 정상 경로가 사라지기 때문이다(§10.1 대응).
   *
   * 관리자 코드를 리소스 타입에서 도출하는 이유는, 타입을 늘릴 때마다 이 함수를 복제하면
   * 그 사본 중 하나가 관리자 분기를 빠뜨려도 아무도 모르기 때문이다(§15.1).
   */
  canRevokeShare(subject: SubjectSnapshot, context: ShareContext): PolicyResult {
    if (subject.id === context.ownerId) return { allowed: true, reason: 'OWNER' };
    if (subject.id === context.grantedBy) return { allowed: true, reason: 'GRANTOR' };
    if (subject.permissions.has(`${context.resourceType}.share.all`)) {
      return { allowed: true, reason: 'ADMIN' };
    }
    return { allowed: false, reason: 'NOT_RELATED' };
  }

  /**
   * DOM-6 소유자 이전 수락.
   *
   * **수락 경로는 §7.3의 인증 게이트형이라 평가기 0~4단계가 한 줄도 실행되지 않는다** —
   * 수령자는 대상 도메인에 대해 아무 권한도 갖고 있지 않기 때문이다. 그래서 이 함수가
   * 유일한 방어선이며, 평가기가 해줬을 검사를 **여기서 명시적으로 재현한다.**
   *
   * 입력은 전부 도메인 행을 `FOR UPDATE` 로 잠근 뒤 읽은 값이어야 한다. 잠금 없이 읽으면
   * 발의 확인과 소유권 변경 사이에 삭제·재이전이 끼어들 수 있다(WT-8).
   */
  canAcceptTransfer(subject: SubjectSnapshot, context: TransferContext): TransferPolicyResult {
    // 수령자 본인만 수락한다. 발의자 자신도 수락할 수 없다 — 2단계로 나눈 의미가 사라진다.
    if (subject.id !== context.toUserId) return { allowed: false, reason: 'NOT_RECIPIENT' };
    if (context.transferStatus !== 'PENDING') return { allowed: false, reason: 'NOT_PENDING' };
    if (context.expiresAt.getTime() <= context.now.getTime()) {
      return { allowed: false, reason: 'EXPIRED' };
    }
    // ② 발의자가 여전히 소유자이며 활성 계정인가 — 발의 후 소유권이 넘어갔거나 발의자가
    //    정지됐다면, 그 발의는 더 이상 소유자의 의사가 아니다.
    if (context.proposerId !== context.domainOwnerId) {
      return { allowed: false, reason: 'PROPOSER_NOT_OWNER' };
    }
    if (context.proposerStatus !== 'ACTIVE') return { allowed: false, reason: 'PROPOSER_INACTIVE' };
    // ① 도메인 상태가 이전 허용 집합 안인가 (SUSPENDED·DELETED 는 이전 불가)
    if (!TRANSFERABLE_STATUSES.includes(context.domainStatus)) {
      return { allowed: false, reason: 'DOMAIN_STATE' };
    }
    // 수령자에게 DENY 제재가 걸려 있으면 거부한다. 허용하면 **자기 도메인을 조회·수정조차 못 하는
    // 소유자**가 생기고(INV-4로 DENY가 소유자 경로를 이긴다), 제재 대상에게 리소스를 떠넘겨
    // 관리 불능 상태를 만드는 경로가 된다.
    if (context.recipientDenied) return { allowed: false, reason: 'RECIPIENT_DENIED' };
    return { allowed: true, reason: 'OK' };
  }
}
