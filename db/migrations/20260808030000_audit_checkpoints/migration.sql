-- 감사 로그 해시 체크포인트 (WP-14, RI-7)
--
-- 기획서 v1.8은 RI-7을 "일 단위 체크포인트 해시 대조"로 재정의했으나, 대조할 원본이
-- 존재하지 않았다. **audit_logs 는 건드리지 않는다**(INV-7 — 기존 테이블 무변경):
-- 이미 쌓인 행은 해시를 소급 계산할 수 없어 컬럼을 추가해도 체인이 중간부터 시작되고,
-- append-only 권한 아래서 기존 행에 값을 채워 넣는 것 자체가 불가능하다.
--
-- 대신 하루치 행 전체의 해시를 별도 테이블에 남긴다. 이 방식은 **체크포인트가 찍힌 뒤의
-- 삭제·변조**를 검출한다(당일 미체크포인트 구간은 검출 범위 밖 — 이 방식의 알려진 한계).

CREATE TABLE IF NOT EXISTS audit.audit_checkpoints (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_date DATE        NOT NULL UNIQUE,
  row_count   BIGINT      NOT NULL,
  prev_hash   CHAR(64),                -- 직전 체크포인트의 chain_hash (첫 행은 NULL)
  day_hash    CHAR(64)    NOT NULL,    -- 그날 행들만의 해시
  chain_hash  CHAR(64)    NOT NULL,    -- sha256(prev_hash || day_hash) — 과거 구간 전체를 봉인
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 하루치 행의 해시. **생성과 검증이 같은 함수를 쓴다**(§15.1 이중 구현 금지) —
-- 표현식을 양쪽에 복사하면 한쪽만 바뀌었을 때 RI-7이 상시 위반을 보고하거나,
-- 반대로 변조를 놓친다.
--
-- jsonb 는 키 순서를 정규화하므로 detail::text 는 같은 값에 대해 안정적이다.
CREATE OR REPLACE FUNCTION audit.day_digest(target_day DATE)
RETURNS TEXT AS $$
  SELECT encode(
    sha256(convert_to(coalesce(string_agg(repr, E'\n' ORDER BY id), ''), 'UTF8')),
    'hex')
  FROM (
    SELECT id,
           concat_ws('|',
             id::text, tenant_id::text, coalesce(actor_id::text, ''), action,
             coalesce(target_type, ''), coalesce(target_id::text, ''),
             detail::text, created_at::text
           ) AS repr
      FROM audit.audit_logs
     WHERE created_at >= target_day
       AND created_at <  target_day + 1
  ) rows;
$$ LANGUAGE sql STABLE;

/* 체인 해시: 직전 체크포인트를 물고 들어가 과거 구간 전체를 봉인한다.
   하루치 해시만 저장하면 공격자가 그날 행을 지우고 그날 해시만 다시 계산해 덮을 수 있다. */
CREATE OR REPLACE FUNCTION audit.chain_digest(prev CHAR(64), day CHAR(64))
RETURNS TEXT AS $$
  SELECT encode(sha256(convert_to(coalesce(prev, '') || day, 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- 체크포인트도 감사 로그와 같은 append-only 를 적용한다.
-- 수정 가능하면 로그를 지운 뒤 체크포인트를 다시 써서 은폐할 수 있다.
GRANT SELECT, INSERT ON audit.audit_checkpoints TO stonex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO stonex_app;
GRANT EXECUTE ON FUNCTION audit.day_digest(DATE) TO stonex_app;
GRANT EXECUTE ON FUNCTION audit.chain_digest(CHAR, CHAR) TO stonex_app;
