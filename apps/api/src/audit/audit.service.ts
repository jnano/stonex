import { Injectable } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { AuditEntry, recordAudit } from './audit-record';

/**
 * 감사 기록 서비스 (WP-6a).
 * 권한 변경(역할 부여/회수 — 가입 시 자동 부여 포함, 매핑 편집, Grant 생성/회수, 정지/삭제)은
 * 반드시 트랜잭션 내에서 record()를 호출한다. 인터셉터 사후 기록 방식은 권한 변경에 금지(기획서 §7.4)
 * — 조회 접근 로그 전용 AuditInterceptor는 WP-6b에서 별도 추가된다.
 */
@Injectable()
export class AuditService {
  /** 변경 행위와 동일 트랜잭션(tx)으로 감사 로그를 남긴다. 실패 시 예외 전파 → 트랜잭션 롤백(INV-6). */
  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await recordAudit(tx, entry);
  }
}
