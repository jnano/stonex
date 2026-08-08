-- RI-9: 고아 모듈 권한 — 미등록 리소스 타입을 가리키는 Grant (Phase 3 WP-K3)
--
-- 리소스 타입이 코드 레지스트리에서 사라졌는데(모듈 제거·배선 누락) 그 타입의 Grant 가
-- 남아 있는 상태. 문제가 둘이다:
--  ① 접근 판정 불가 — 로더가 404 로 정규화하므로 Grant 는 영원히 죽은 데이터다
--  ② 검사 불가 — RI-4/5/8 의 RESOURCE_UNION 플레이스홀더는 **등록된 타입만** 순회하므로,
--     미등록 타입 Grant 는 조인할 테이블이 없어 어떤 불변식에도 잡히지 않는다.
--     테이블이 이미 삭제된 경우 조인 자체가 SQL 오류가 나는 것을 막기 위한 설계이며,
--     그 사각을 이 불변식이 맡는다 — "검사 못 한다"를 "이상 없다"로 접지 않는다.
--
-- knownResourceTypes(시드)가 아니라 **registeredResourceTypes(레지스트리)** 기준이다:
-- 시드에는 남았지만 코드 등록이 사라진 어긋남이 바로 이 검사의 표적이다.
--
-- **자동 회수하지 않는다(L-3 보고)** — 모듈이 일시 제거됐다 돌아올 수 있고(배포 롤백),
-- 그 사이 Grant 를 지우면 재설치 후 공유가 소리 없이 사라진다.
WITH ctx AS (SELECT $1::jsonb AS c),
registered AS (
  SELECT jsonb_array_elements_text(c -> 'registeredResourceTypes') AS resource_type FROM ctx
)
SELECT
  'RI-9'                                            AS ri_id,
  g.id::text                                        AS subject,
  jsonb_build_object(
    'resourceType', g.resource_type,
    'resourceId', g.resource_id,
    'subjectId', g.subject_id,
    'effect', g.effect,
    'reason', 'unregistered_resource_type'
  )                                                 AS detail
FROM resource_grants g
WHERE NOT EXISTS (
  SELECT 1 FROM registered r WHERE r.resource_type = g.resource_type
);
