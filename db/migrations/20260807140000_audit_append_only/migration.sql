-- 감사 로그 append-only 강제 (기획서 §10.3) + 애플리케이션 전용 DB 역할
--
-- 감사 로그는 삽입만 가능해야 한다. 애플리케이션이 쓰는 DB 계정에서 UPDATE/DELETE 권한을
-- 제거하여, 코드 실수·침해 상황에서도 기록을 고칠 수 없게 한다(§10.3).
-- 정리(보존 기간 경과 파티션 분리·아카이브)는 관리자 계정의 별도 절차로만 수행한다.

-- 애플리케이션 전용 역할. 운영에서는 배포 시 비밀번호를 주입하고 이 역할로 접속한다.
-- (개발 환경에서는 슈퍼유저로 접속하므로 이 제약이 적용되지 않는다 — 테스트는 이 역할로 검증한다)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stonex_app') THEN
    CREATE ROLE stonex_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, audit TO stonex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stonex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stonex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stonex_app;

-- 감사 로그: SELECT·INSERT 만 허용. UPDATE/DELETE/TRUNCATE 금지
REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM stonex_app;
GRANT SELECT, INSERT ON audit.audit_logs TO stonex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO stonex_app;

-- 파티션 생성 함수는 애플리케이션이 호출할 수 있어야 한다(월 파티션 자동 생성 워커)
GRANT EXECUTE ON FUNCTION audit.create_partition(DATE) TO stonex_app;

-- 기존 파티션에도 동일 권한 적용
DO $$
DECLARE part RECORD;
BEGIN
  FOR part IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relkind = 'r'
  LOOP
    EXECUTE format('REVOKE ALL ON audit.%I FROM stonex_app', part.relname);
    EXECUTE format('GRANT SELECT, INSERT ON audit.%I TO stonex_app', part.relname);
  END LOOP;
END $$;
