-- RI-6: 시스템 역할의 코드·존재가 변조되지 않았다 (기획서 §14.3)
--
-- 정본은 시드의 ROLES 이며 $1 컨텍스트로 주입된다(하드코딩 금지 — 시드가 바뀌면
-- 이 검사도 함께 따라가야 한다). 위반 유형 셋을 한 번에 본다:
--   ① 시드가 정의한 시스템 역할이 테넌트에 없음  ② is_system 플래그가 꺼짐
--   ③ 시드에 없는 코드가 is_system 을 달고 있음(위장 시스템 역할)
-- 대응: 즉시 호출 알림 + break-glass 런북 (자동 조치 불가)
WITH ctx AS (SELECT $1::jsonb AS c),
seeded AS (
  SELECT jsonb_array_elements_text(c -> 'systemRoles') AS code FROM ctx
)
SELECT 'RI-6' AS ri_id, t.id::text AS subject,
       jsonb_build_object('kind', 'missing', 'roleCode', s.code, 'tenant', t.name) AS detail
  FROM tenants t
 CROSS JOIN seeded s
 WHERE t.status = 'ACTIVE'
   AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.tenant_id = t.id AND r.code = s.code)

UNION ALL

SELECT 'RI-6', r.id::text,
       jsonb_build_object('kind', 'flag_cleared', 'roleCode', r.code, 'tenant', r.tenant_id)
  FROM roles r
 WHERE EXISTS (SELECT 1 FROM seeded s WHERE s.code = r.code)
   AND r.is_system = false

UNION ALL

SELECT 'RI-6', r.id::text,
       jsonb_build_object('kind', 'unexpected_system_role', 'roleCode', r.code, 'tenant', r.tenant_id)
  FROM roles r
 WHERE r.is_system = true
   AND NOT EXISTS (SELECT 1 FROM seeded s WHERE s.code = r.code);
