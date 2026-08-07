# DB 마이그레이션 (forward-only)

Prisma 마이그레이션 이력 위치. WP-1에서 최초 스키마를 작성한다.

규칙(기획서 §16.3-1): permissions·roles·매핑의 모든 변경은 forward-only 마이그레이션으로만 수행한다. 운영 DB 직접 수정 금지 — 유일한 예외는 §10.1 break-glass 절차. `audit_logs` 파티셔닝·DB 계정 권한 분리는 raw SQL 마이그레이션으로 처리한다(작업지시서 R-1).
