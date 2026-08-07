-- 감사 로그 (기획서 §5.2) — 전용 스키마 `audit` 에 둔다.
--
-- 왜 public 이 아닌가: audit_logs 는 월 단위 파티션 테이블이라 Prisma 스키마로 표현할 수 없다.
-- public 에 두면 Prisma 가 "스키마에 없는 테이블"을 드리프트로 판정해 migrate 과정에서 삭제해버린다
-- (실제로 WP-2 작업 중 dev·test DB 양쪽에서 소실됨). 전용 스키마로 분리하면 Prisma 관리 범위 밖이
-- 되어 안전하다. 접근은 raw SQL 로만 하며, 경로는 반드시 audit.audit_logs 로 명시한다.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.audit_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id    UUID NOT NULL,
  actor_id     UUID,                            -- NULL = 시스템 행위
  action       VARCHAR(100) NOT NULL,
  target_type  VARCHAR(50),
  target_id    UUID,
  detail       JSONB NOT NULL DEFAULT '{}',
  ip_address   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit.audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit.audit_logs (target_type, target_id);

-- 지정 월의 파티션 생성(존재 시 무시). 운영 절차: 매월 익월 파티션을 선생성한다(WP-6b 워커 편입 예정).
CREATE OR REPLACE FUNCTION audit.create_partition(target_month DATE)
RETURNS void AS $$
DECLARE
  part_start DATE := date_trunc('month', target_month)::date;
  part_end   DATE := (date_trunc('month', target_month) + interval '1 month')::date;
  part_name  TEXT := 'audit_logs_' || to_char(part_start, 'YYYYMM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS audit.%I PARTITION OF audit.audit_logs FOR VALUES FROM (%L) TO (%L)',
    part_name, part_start, part_end
  );
END;
$$ LANGUAGE plpgsql;

SELECT audit.create_partition(now()::date);
SELECT audit.create_partition((now() + interval '1 month')::date);
