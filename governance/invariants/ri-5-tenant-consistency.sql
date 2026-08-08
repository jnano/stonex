-- RI-5: user·role·resource 의 tenant 가 일치한다 (교차 테넌트 누수 검출)
--
-- FK 가 tenant 까지 강제하지 못하는 논리 참조가 많아(§5.3) 이 검사가 유일한 방어선이다.
--
-- WP-K3: Grant→리소스 테넌트 대조는 타입별 UNION 하드코딩 대신 RESOURCE_UNION 플레이스홀더 치환 —
-- 기존에는 file·domain 두 블록이 SQL 에 박혀 있어, 신규 타입은 검사 없이 통과했다(fail-open).
-- 대응: L-2(동결 후보).
WITH resources AS (
  {{RESOURCE_UNION}}
)
SELECT 'RI-5' AS ri_id, ur.user_id::text AS subject,
       jsonb_build_object('kind', 'user_role', 'roleId', ur.role_id,
                          'userTenant', u.tenant_id, 'roleTenant', r.tenant_id) AS detail
  FROM user_roles ur
  JOIN users u ON u.id = ur.user_id
  JOIN roles r ON r.id = ur.role_id
 WHERE u.tenant_id <> r.tenant_id OR ur.tenant_id <> u.tenant_id

UNION ALL

SELECT 'RI-5', g.id::text,
       jsonb_build_object('kind', 'grant_subject', 'grantTenant', g.tenant_id,
                          'subjectTenant', u.tenant_id)
  FROM resource_grants g
  JOIN users u ON u.id = g.subject_id
 WHERE u.tenant_id <> g.tenant_id

UNION ALL

SELECT 'RI-5', g.id::text,
       jsonb_build_object('kind', 'grant_resource', 'resourceType', g.resource_type,
                          'grantTenant', g.tenant_id, 'resourceTenant', res.tenant_id)
  FROM resource_grants g
  JOIN resources res ON res.resource_type = g.resource_type AND res.id = g.resource_id
 WHERE res.tenant_id <> g.tenant_id;
