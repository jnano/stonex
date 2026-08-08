-- ADM-4 감사 조회 인덱스 (WP-15, WT-21)
--
-- 기존 인덱스는 `(tenant_id, created_at)`·`(target_type, target_id)` 둘뿐이라
-- **행위자·행위 유형 필터에 인덱스가 없었다.** 파티션 프루닝은 "어느 파티션을 볼지"만
-- 좁힐 뿐, 파티션 **내부**는 여전히 순차 스캔이 된다.
--
-- 파티션 부모에 만들면 PostgreSQL 이 각 파티션에 로컬 인덱스를 자동 생성한다.
CREATE INDEX IF NOT EXISTS idx_audit_actor_created
  ON audit.audit_logs (tenant_id, actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_action_created
  ON audit.audit_logs (tenant_id, action, created_at DESC);
