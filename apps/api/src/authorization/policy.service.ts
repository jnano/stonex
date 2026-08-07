import { Injectable } from '@nestjs/common';

/**
 * 관계형 2차 인가의 표준 위치 (기획서 §7.3 — WP-3 항목 5, 뼈대).
 *
 * 규약:
 * 1. "소유자 또는 공유 생성자"(FILE-5), "발의자+수락자 2단계"(DOM-6)처럼 단일 Permission
 *    코드로 환원되지 않는 관계 조건은 반드시 이 서비스의 **명명된 정책 함수**로 구현한다.
 *    예정 함수: canRevokeShare(subject, grant) — Phase 2 / FILE-5 에서 구현.
 * 2. 관계 조건을 핸들러에 임의 구현하는 것을 금지한다 — 감사와 권한 시뮬레이터(ADM-5)가
 *    동일 로직을 재사용할 수 있어야 한다. (기계 검출: governance/semgrep 의 우회 쿼리 룰)
 * 3. 각 정책 함수의 규칙은 기능 명세(기획서 §6)의 해당 항목을 유일한 출처로 삼고,
 *    함수 doc 주석에 §6 식별자(FILE-5 등)를 명시한다.
 *
 * Phase 1 회원 관리에는 관계 조건이 없어 함수가 아직 없다 — 구조와 규약만 확립한다.
 */
@Injectable()
export class PolicyService {}
