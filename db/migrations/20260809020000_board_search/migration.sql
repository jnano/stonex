-- board 모듈 WP-B4: 검색·조회수 (db/README.md 등재)
--
-- 한국어 검색 엔진(GD-3): 결정은 pg_bigm 이었으나 **환경 실측 결과 로컬·CI(postgres:16-alpine)
-- 어디에도 없다**(별도 빌드 필요). 같은 취지(부분일치·운영 부담 최소)를 내장 contrib
-- pg_trgm(3-gram)이 충족하므로 이를 1호 어댑터로 쓴다 — ILIKE '%…%' 를 GIN 인덱스로
-- 가속한다. pg_bigm 전환은 확장 설치 + 이 인덱스 교체 + 어댑터 교체로 국소화돼 있다.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_posts_title_trgm ON posts USING GIN (title gin_trgm_ops);
CREATE INDEX idx_posts_body_trgm  ON posts USING GIN (body_md gin_trgm_ops);

-- 조회수 (기능모듈 view-count, §6.4) — 요청 경로에서 쓰지 않고 버퍼가 주기 플러시한다
ALTER TABLE posts ADD COLUMN view_count BIGINT NOT NULL DEFAULT 0;
