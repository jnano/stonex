-- RI-8: 부여자가 지금은 그 Grant 를 만들 권한이 없는 ALLOW Grant 부재 (기획서 v1.8, WT-7)
--
-- **권한 화석**: 부여 시점에는 정당했던 Grant 가, 부여자가 강등·정지된 뒤에도 그대로 남는다.
-- Grant 는 소유자 관계와 무관하게 독립적으로 살아 있으므로 아무도 이를 눈치채지 못한다.
--
-- 지금 그 Grant 를 만들 수 있는 조건은 둘 중 하나다:
--   ① 부여자가 대상 리소스의 소유자이고 `{type}.share` 를 역할로 보유
--   ② 부여자가 `{type}.share.all` 을 역할로 보유 (관리자 경로)
-- 어느 쪽도 아니면 화석이다. 만료된 역할 부여(user_roles.expires_at)는 보유로 치지 않는다.
--
-- **자동 회수하지 않는다(L-3 보고)** — 부여자의 강등이 공유 자체를 무효로 만드는지는
-- 업무 판단이며, 자동 삭제하면 관리자 교체 때마다 정상 공유가 대량으로 끊긴다.
WITH ctx AS (SELECT $1::jsonb AS c),
known AS (
  SELECT jsonb_array_elements_text(c -> 'knownResourceTypes') AS resource_type FROM ctx
),
granter_perms AS (
  SELECT ur.user_id, p.code
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE ur.expires_at IS NULL OR ur.expires_at > now()
),
owned AS (
  SELECT g.id AS grant_id, g.granted_by,
         CASE g.resource_type
           WHEN 'file'   THEN (SELECT f.owner_id FROM files f WHERE f.id = g.resource_id)
           WHEN 'domain' THEN (SELECT d.owner_id FROM domains d WHERE d.id = g.resource_id)
         END AS owner_id
    FROM resource_grants g
)
SELECT
  'RI-8'                                            AS ri_id,
  g.id::text                                        AS subject,
  jsonb_build_object(
    'resourceType', g.resource_type,
    'resourceId', g.resource_id,
    'permission', p.code,
    'grantedBy', g.granted_by,
    'grantedAt', g.granted_at,
    'reason', 'granter_lost_share_permission'
  )                                                 AS detail
FROM resource_grants g
JOIN permissions p ON p.id = g.permission_id
JOIN owned o ON o.grant_id = g.id
WHERE g.effect = 'ALLOW'
  AND EXISTS (SELECT 1 FROM known k WHERE k.resource_type = g.resource_type)
  AND NOT EXISTS (
    SELECT 1 FROM granter_perms gp
     WHERE gp.user_id = g.granted_by
       AND gp.code = g.resource_type || '.share.all'
  )
  AND NOT (
    o.owner_id = g.granted_by
    AND EXISTS (
      SELECT 1 FROM granter_perms gp
       WHERE gp.user_id = g.granted_by
         AND gp.code = g.resource_type || '.share'
    )
  );
