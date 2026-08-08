-- RI-2: 자기 자신에게 역할을 부여한 기록이 없다 (기획서 §4.6-1, ATK-1)
--
-- 서비스 계층이 본인 대상 역할 변경을 전면 금지하므로, 이 행이 존재한다는 것은
-- 서비스를 우회한 직접 INSERT 를 뜻한다. 대응: L-2(동결 후보).
SELECT
  'RI-2'                                            AS ri_id,
  ur.user_id::text                                  AS subject,
  jsonb_build_object(
    'roleId', ur.role_id,
    'grantedBy', ur.granted_by,
    'grantedAt', ur.granted_at
  )                                                 AS detail
FROM user_roles ur
WHERE ur.granted_by = ur.user_id;
