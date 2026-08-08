-- RI-1: 테넌트마다 활성 SUPER_ADMIN 이 1명 이상 존재한다 (기획서 §14.3, §10.1)
--
-- **부재가 위반인 존재형**이라 위반 행을 합성해야 한다(WT-33). 조건을 만족하는 행을 세는
-- 형태로 쓰면 위반 시 0행이 되어 순찰이 "이상 없음"으로 읽는다.
-- 대응: 즉시 호출 알림 + break-glass 런북 (자동 조치 불가 — 사람만 복구할 수 있다)
SELECT
  'RI-1'                                            AS ri_id,
  t.id::text                                        AS subject,
  jsonb_build_object(
    'tenant', t.name,
    'runbook', 'docs/권한 관리 웹 애플리케이션 기획서/break-glass-runbook-v1.md'
  )                                                 AS detail
FROM tenants t
WHERE t.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN users u ON u.id = ur.user_id
     WHERE ur.tenant_id = t.id
       AND r.code = 'SUPER_ADMIN'
       AND u.status = 'ACTIVE'
       AND u.deleted_at IS NULL
       AND (ur.expires_at IS NULL OR ur.expires_at > now())
  );
