-- RI-3: 모든 **ALLOW** Grant 가 리소스 타입별 화이트리스트(§4.4) 안에 있다
--
-- DENY 는 §9.6의 차단 수단이라 화이트리스트 대상이 아니다(WT-27) — 포함시키면
-- 관리자가 걸어둔 제재를 순찰이 스스로 회수하게 된다.
--
-- 화이트리스트 정본은 `db/seeds/permissions.ts` 의 GRANT_WHITELIST 이며 $1 컨텍스트로
-- 주입된다. **비어 있으면 이 쿼리는 0행(=이상 없음)을 반환한다** — fail-open 이므로
-- 순찰 워커가 실행 전에 컨텍스트를 검증해 "검사 불가"로 중단시킨다(WT fail-open 대응).
--
-- 미등록 리소스 타입은 여기서 제외한다. §9.1로 추가된 신규 모듈의 정상 Grant 를
-- "화이트리스트 밖"으로 판정하면 L-1 이 전량 삭제해 버린다.
-- 대응: L-1 (자동 회수, blast-radius 상한 적용)
WITH ctx AS (SELECT $1::jsonb AS c),
whitelist AS (
  SELECT e.key AS resource_type, jsonb_array_elements_text(e.value) AS code
    FROM ctx, jsonb_each((SELECT c -> 'grantWhitelist' FROM ctx)) AS e
),
known AS (
  SELECT jsonb_array_elements_text(c -> 'knownResourceTypes') AS resource_type FROM ctx
)
SELECT
  'RI-3'                                            AS ri_id,
  g.id::text                                        AS subject,
  jsonb_build_object(
    'resourceType', g.resource_type,
    'resourceId', g.resource_id,
    'permission', p.code,
    'subjectId', g.subject_id,
    'grantedBy', g.granted_by
  )                                                 AS detail
FROM resource_grants g
JOIN permissions p ON p.id = g.permission_id
WHERE g.effect = 'ALLOW'
  AND EXISTS (SELECT 1 FROM known k WHERE k.resource_type = g.resource_type)
  AND NOT EXISTS (
    SELECT 1 FROM whitelist w
     WHERE w.resource_type = g.resource_type AND w.code = p.code
  );
