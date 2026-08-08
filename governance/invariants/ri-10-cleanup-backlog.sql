-- RI-10: 소유자 정리 백로그 (Phase 3 WP-K2, RT-27 훅 실패 격리)
--
-- 회원 삭제는 O(1) 표식 + 퍼지 잡 큐잉으로 끝나고(DEC-3 — 은닉은 표식이 즉시 담당),
-- 실제 리소스 정리는 워커가 배치로 이어받는다. 워커가 죽거나 훅이 반복 실패하면
-- 잡이 조용히 쌓인다 — 은닉 덕에 사용자에게는 안 보이지만, 저장 공간과 RI-4(고아 Grant)
-- 정합이 무한정 미뤄진다. 실패는 조용히 쌓이는 것이 아니라 순찰에 드러나야 한다.
--
-- 검출: ① FAILED (재시도 소진 — 훅 버그 신호)
--      ② 30분 넘게 끝나지 않은 PENDING/RUNNING (워커 정지·행 잠김·비정상 종료로 굳은 잡)
-- 대응: L-2 (운영자 확인 — 훅 버그면 코드 수정, 워커 정지면 재기동. 자동 회수 없음:
--       원인을 모른 채 잡을 리셋하면 같은 실패를 무한 반복한다)
SELECT
  'RI-10'                       AS ri_id,
  j.id::text                    AS subject,
  jsonb_build_object(
    'userId',   j.user_id,
    'tenantId', j.tenant_id,
    'status',   j.status,
    'attempts', j.attempts,
    'lastError', j.last_error,
    'ageMinutes', floor(extract(epoch FROM (now() - j.created_at)) / 60)
  )                             AS detail
FROM owner_cleanup_jobs j
WHERE j.status = 'FAILED'
   OR (j.status IN ('PENDING', 'RUNNING') AND j.updated_at < now() - interval '30 minutes');
