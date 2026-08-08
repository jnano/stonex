-- RI-7: 감사 로그 해시 체인 무결성 (기획서 v1.8 §14.3)
--
-- v1.6의 "시퀀스 연속성"은 IDENTITY 시퀀스가 롤백에 되돌아가지 않고 INV-6이 롤백을
-- 의무화하므로 **상시 오탐**이었다(실측 확인). 대신 일 단위 체크포인트와 대조한다.
--
-- 해시 계산은 `audit.day_digest`·`audit.chain_digest` 를 쓴다 — 생성과 검증이 같은
-- 함수를 공유해야 표현식이 갈라지지 않는다(§15.1).
-- 검출 범위: 체크포인트가 찍힌 뒤의 삭제·변조. 당일 미체크포인트 구간은 범위 밖이다.
-- 대응: L-3 (보고) — 자동 조치 대상이 아니다.
SELECT
  'RI-7'                                            AS ri_id,
  c.period_date::text                               AS subject,
  jsonb_build_object(
    'kind', CASE WHEN audit.day_digest(c.period_date) <> c.day_hash
                 THEN 'day_hash_mismatch' ELSE 'chain_hash_mismatch' END,
    'recordedRows', c.row_count,
    'currentRows', (SELECT count(*) FROM audit.audit_logs l
                     WHERE l.created_at >= c.period_date AND l.created_at < c.period_date + 1),
    'checkpointedAt', c.created_at
  )                                                 AS detail
FROM audit.audit_checkpoints c
WHERE audit.day_digest(c.period_date) <> c.day_hash
   OR audit.chain_digest(c.prev_hash, c.day_hash) <> c.chain_hash;
