-- RI-4: 고아 Grant 부재 (기획서 §14.3)
--
-- "고아"는 세 가지다 — ① 리소스가 물리적으로 없음 ② 리소스가 소프트 삭제됨
-- ③ 리소스 소유자가 삭제된 계정. 셋 다 정리 누락이며, 남겨두면 리소스가 재생성되거나
-- 소유자가 복구될 때 옛 공유가 되살아난다.
-- 주체(subject) 가 사라진 Grant 도 같은 이유로 포함한다.
--
-- `NOT IN (서브쿼리)` 는 NULL 하나에 조용히 0행이 되는 fail-open 을 만들므로 쓰지 않는다.
--
-- WP-K3: 리소스 테이블 접근은 타입별 WHEN 분기 하드코딩 대신
-- RESOURCE_UNION 플레이스홀더 — 레지스트리가 등록된 타입 전체를
-- (resource_type, id, owner_id, tenant_id, deleted_at) 로 정규화해 생성한다.
-- 신규 타입은 서술자 등록만으로 이 검사에 자동 편입된다.
-- 대응: L-1 (자동 회수, blast-radius 상한 적용)
WITH ctx AS (SELECT $1::jsonb AS c),
known AS (
  SELECT jsonb_array_elements_text(c -> 'knownResourceTypes') AS resource_type FROM ctx
),
resources AS (
  {{RESOURCE_UNION}}
),
target AS (
  SELECT g.id, g.resource_type, g.resource_id, g.subject_id,
         r.id IS NOT NULL                            AS resource_exists,
         COALESCE(r.deleted_at IS NOT NULL, false)   AS resource_deleted,
         COALESCE(ou.deleted_at IS NOT NULL, false)  AS owner_deleted
    FROM resource_grants g
    LEFT JOIN resources r ON r.resource_type = g.resource_type AND r.id = g.resource_id
    LEFT JOIN users ou ON ou.id = r.owner_id
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
