-- RI-5: user·role·resource 의 tenant 가 일치한다 (교차 테넌트 누수 검출)
--
-- FK 가 tenant 까지 강제하지 못하는 논리 참조가 많아(§5.3) 이 검사가 유일한 방어선이다.
-- 대응: L-2(동결 후보).
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
                          'grantTenant', g.tenant_id, 'resourceTenant', f.tenant_id)
  FROM resource_grants g
  JOIN files f ON f.id = g.resource_id
 WHERE g.resource_type = 'file' AND f.tenant_id <> g.tenant_id

UNION ALL

SELECT 'RI-5', g.id::text,
       jsonb_build_object('kind', 'grant_resource', 'resourceType', g.resource_type,
                          'grantTenant', g.tenant_id, 'resourceTenant', d.tenant_id)
  FROM resource_grants g
  JOIN domains d ON d.id = g.resource_id
 WHERE g.resource_type = 'domain' AND d.tenant_id <> g.tenant_id;
