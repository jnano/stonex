-- RI-4: 고아 Grant 부재 (기획서 §14.3)
--
-- "고아"는 세 가지다 — ① 리소스가 물리적으로 없음 ② 리소스가 소프트 삭제됨
-- ③ 리소스 소유자가 삭제된 계정. 셋 다 정리 누락이며, 남겨두면 리소스가 재생성되거나
-- 소유자가 복구될 때 옛 공유가 되살아난다.
-- 주체(subject) 가 사라진 Grant 도 같은 이유로 포함한다.
--
-- `NOT IN (서브쿼리)` 는 NULL 하나에 조용히 0행이 되는 fail-open 을 만들므로 쓰지 않는다.
-- 대응: L-1 (자동 회수, blast-radius 상한 적용)
WITH ctx AS (SELECT $1::jsonb AS c),
known AS (
  SELECT jsonb_array_elements_text(c -> 'knownResourceTypes') AS resource_type FROM ctx
),
target AS (
  SELECT g.*,
         CASE g.resource_type
           WHEN 'file'   THEN (SELECT f.deleted_at IS NOT NULL FROM files f WHERE f.id = g.resource_id)
           WHEN 'domain' THEN (SELECT d.deleted_at IS NOT NULL FROM domains d WHERE d.id = g.resource_id)
         END AS resource_deleted,
         CASE g.resource_type
           WHEN 'file'   THEN EXISTS (SELECT 1 FROM files f WHERE f.id = g.resource_id)
           WHEN 'domain' THEN EXISTS (SELECT 1 FROM domains d WHERE d.id = g.resource_id)
         END AS resource_exists,
         CASE g.resource_type
           WHEN 'file'   THEN (SELECT u.deleted_at IS NOT NULL FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = g.resource_id)
           WHEN 'domain' THEN (SELECT u.deleted_at IS NOT NULL FROM domains d JOIN users u ON u.id = d.owner_id WHERE d.id = g.resource_id)
         END AS owner_deleted
    FROM resource_grants g
   WHERE EXISTS (SELECT 1 FROM known k WHERE k.resource_type = g.resource_type)
)
SELECT
  'RI-4'                                            AS ri_id,
  t.id::text                                        AS subject,
  jsonb_build_object(
    'resourceType', t.resource_type,
    'resourceId', t.resource_id,
    'subjectId', t.subject_id,
    'reason', CASE
      WHEN NOT t.resource_exists THEN 'resource_missing'
      WHEN t.resource_deleted    THEN 'resource_deleted'
      WHEN t.owner_deleted       THEN 'owner_deleted'
      ELSE 'subject_missing'
    END
  )                                                 AS detail
FROM target t
WHERE NOT t.resource_exists
   OR t.resource_deleted
   OR t.owner_deleted
   OR NOT EXISTS (
        SELECT 1 FROM users u
         WHERE u.id = t.subject_id AND u.deleted_at IS NULL
      );
