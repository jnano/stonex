import { Injectable } from '@nestjs/common';
import { SubjectSnapshot } from './types';

export interface ShareContext {
  /** 공유 대상 리소스의 소유자 */
  ownerId: string;
  /** 이 Grant 를 만든 사람 */
  grantedBy: string;
}

export interface PolicyResult {
  allowed: boolean;
  reason: 'OWNER' | 'GRANTOR' | 'ADMIN' | 'NOT_RELATED';
}

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
   * FILE-5 공유 회수: **소유자 본인 또는 공유 생성자**.
   * 여기에 `file.share.all` 보유자(관리자)를 더한다 — 계정이 탈취·정지되면 소유자도 생성자도
   * 회수할 수 없어, 유출된 공유를 끊을 정상 경로가 사라지기 때문이다(§10.1 대응).
   */
  canRevokeShare(subject: SubjectSnapshot, context: ShareContext): PolicyResult {
    if (subject.id === context.ownerId) return { allowed: true, reason: 'OWNER' };
    if (subject.id === context.grantedBy) return { allowed: true, reason: 'GRANTOR' };
    if (subject.permissions.has('file.share.all')) return { allowed: true, reason: 'ADMIN' };
    return { allowed: false, reason: 'NOT_RELATED' };
  }
}
