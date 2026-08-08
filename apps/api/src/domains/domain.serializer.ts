/**
 * 도메인 응답 직렬화 (기획서 §10.2) — **화이트리스트 방식**.
 * 파일과 같은 이유로 블랙리스트를 쓰지 않는다(컬럼 추가 시 자동 유출).
 */
import { txtRecordValue } from './fqdn';

export interface DomainSummary {
  id: string;
  fqdn: string;
  status: string;
  verifiedAt: string | null;
  createdAt: string;
  /** 요청자와 이 도메인의 관계 — 목록 UI 가 소유/위임을 구분하는 데 쓴다 */
  relation: 'owner' | 'shared';
  /**
   * DNS 에 게시해야 할 TXT 값. **미검증 상태에서만 내려간다.**
   * 이 값은 본래 DNS 에 공개 게시되는 값이라 비밀이 아니지만, 검증이 끝난 뒤에도 계속 노출하면
   * 토큰 폐기(재사용 방지)를 하지 않았다는 뜻이 되므로 상태와 함께 사라지는 것이 정상이다.
   */
  verificationRecord: { name: string; value: string } | null;
}

interface DomainRow {
  id: string;
  fqdn: string;
  status: string;
  verify_token: string | null;
  verified_at: Date | null;
  created_at: Date;
  owner_id: string;
}

export function toDomainSummary(domain: DomainRow, viewerId: string): DomainSummary {
  return {
    id: domain.id,
    fqdn: domain.fqdn,
    status: domain.status,
    verifiedAt: domain.verified_at?.toISOString() ?? null,
    createdAt: domain.created_at.toISOString(),
    relation: domain.owner_id === viewerId ? 'owner' : 'shared',
    verificationRecord: domain.verify_token
      ? { name: `_stonex-challenge.${domain.fqdn}`, value: txtRecordValue(domain.verify_token) }
      : null,
  };
}
