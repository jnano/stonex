-- Phase 2 스키마 되돌리기 (WP-15, WT-22)
--
-- **실행 전에 반드시 pg_dump 를 뜬다. 이 스크립트는 데이터를 삭제한다.**
--
-- Phase 2 는 기존 테이블의 컬럼을 하나도 바꾸지 않았다(INV-7). 그래서 되돌림은
-- "신규 테이블·인덱스 제거"로 끝나고 Phase 1 데이터는 손대지 않는다.
-- 유일한 예외는 domains 의 유니크 제약이며, 아래에서 원래 형태로 복원한다.

BEGIN;

-- ── WP-14b: L-2 동결 ─────────────────────────────────────────
DROP TABLE IF EXISTS governance_freezes;

-- ── WP-14a: 감사 해시 체크포인트 ─────────────────────────────
DROP TABLE IF EXISTS audit.audit_checkpoints;
DROP FUNCTION IF EXISTS audit.chain_digest(CHAR, CHAR);
DROP FUNCTION IF EXISTS audit.day_digest(DATE);

-- ── WP-15: 감사 조회 인덱스 ──────────────────────────────────
DROP INDEX IF EXISTS audit.idx_audit_actor_created;
DROP INDEX IF EXISTS audit.idx_audit_action_created;

-- ── WP-13: 도메인 소유자 이전 ────────────────────────────────
DROP TABLE IF EXISTS domain_transfers;

-- ── WP-12: 도메인 검증 ───────────────────────────────────────
DROP TABLE IF EXISTS domain_verification_attempts;
DROP INDEX IF EXISTS idx_domains_owner;

-- domains 유니크를 Phase 1 형태(전체 유니크)로 되돌린다.
-- **주의**: 소프트 삭제된 행과 살아있는 행의 fqdn 이 겹치면 이 구문이 실패한다.
-- 그 경우 겹치는 삭제 행을 물리 삭제하거나, 부분 유니크를 그대로 두고 넘어간다
-- (부분 유니크는 전체 유니크보다 느슨하므로 Phase 1 코드와도 양립한다).
DROP INDEX IF EXISTS uq_domains_fqdn_live;
CREATE UNIQUE INDEX IF NOT EXISTS "domains_tenant_id_fqdn_key"
  ON "domains" ("tenant_id", "fqdn");

-- ── WP-9: 업로드 세션 ────────────────────────────────────────
DROP TABLE IF EXISTS file_uploads;

-- ── 신규 Permission 회수 ─────────────────────────────────────
-- 역할 매핑을 먼저 지워야 FK(RESTRICT)에 걸리지 않는다.
DELETE FROM role_permissions
 WHERE permission_id IN (
   SELECT id FROM permissions
    WHERE code IN ('file.share.all', 'domain.share', 'domain.share.all',
                   'governance.read', 'governance.freeze.manage')
 );
DELETE FROM resource_grants
 WHERE permission_id IN (
   SELECT id FROM permissions WHERE code IN ('domain.share', 'file.share.all', 'domain.share.all')
 );
DELETE FROM permissions
 WHERE code IN ('file.share.all', 'domain.share', 'domain.share.all',
                'governance.read', 'governance.freeze.manage');

COMMIT;

-- 되돌린 뒤 마이그레이션 이력을 맞춘다(맞추지 않으면 다음 배포가 충돌한다):
--   prisma migrate resolve --rolled-back 20260808000330_file_upload_sessions
--   prisma migrate resolve --rolled-back 20260808014055_domain_verification
--   prisma migrate resolve --rolled-back 20260808021744_domain_transfers
--   prisma migrate resolve --rolled-back 20260808030000_audit_checkpoints
--   prisma migrate resolve --rolled-back 20260808035001_governance_freezes
--   prisma migrate resolve --rolled-back 20260808050000_audit_query_indexes
