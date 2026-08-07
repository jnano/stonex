# DB — 스키마·마이그레이션·시드

## 구성

- `schema.prisma` — 기획서 §5.2(v1.6) DDL의 Prisma 표현
- `migrations/` — forward-only 마이그레이션 (기획서 §16.3-1: 운영 DB 직접 수정 금지, 유일한 예외는 §10.1 break-glass)
- `seeds/permissions.ts` — Permission·역할 정의의 **유일한 출처** (§10.3·§16.2)
- `seeds/run.ts` — 시드 실행기(멱등) / `seeds/verify.ts` — DB 상태와 정의 대조(WP-1 DoD)

## 명령

```bash
pnpm db:migrate   # 마이그레이션 적용 (비대화형 deploy)
pnpm db:seed      # 시드 (SEED_SUPER_ADMIN_EMAIL/PASSWORD 필요 — .env.example 참조)
pnpm db:verify    # 기획서 §4.4·§4.5 표와 DB 상태 대조
pnpm g4           # G-4 시드 정합성 정적 검사 (CI 게이트)
```

## Prisma-수기 SQL 이중 관리 지점 (작업지시서 R-1 — 이 목록이 유일한 출처)

Prisma 스키마가 표현하지 못해 마이그레이션 SQL에 수기로 관리하는 항목. **스키마 변경 시 이 목록과의 정합을 코드 리뷰에서 확인할 것.**

| 항목 | 위치 |
|---|---|
| `permissions.scope` CHECK (global\|owned) | `20260807112119_init` |
| `resource_grants.effect` CHECK (ALLOW\|DENY) | `20260807112119_init` |
| `files` 부분 인덱스 `idx_files_owner` (WHERE status='ACTIVE') | `20260807112119_init` |
| `audit.audit_logs` 파티션 테이블 전체 (Prisma 모델 없음 — raw SQL로만 접근) | `20260807130000_audit_schema` |
| `audit.create_partition(month)` 함수 | `20260807130000_audit_schema` |

## 감사 로그는 전용 스키마 `audit` 에 둔다 (중요)

`audit.audit_logs` 는 월 파티션 테이블이라 Prisma 스키마로 표현할 수 없다. 이를 `public` 에 두면
**Prisma 가 "스키마에 없는 테이블"을 드리프트로 판정해 마이그레이션에 `DROP TABLE audit_logs` 를 자동 생성**한다
(WP-2 작업 중 dev·test DB 양쪽에서 실제로 소실됨). 전용 스키마로 분리하면 Prisma 관리 범위 밖이 되어 안전하다.

- 접근은 raw SQL 로만 하며 경로를 항상 `audit.audit_logs` 로 명시한다.
- **`prisma migrate dev` 로 생성된 마이그레이션에 감사 로그 관련 DROP 구문이 없는지 반드시 확인한다.**
- 일상 적용은 `pnpm db:migrate`(= `migrate deploy`)를 사용한다.

## audit_logs 파티션 운영

- 월 단위 RANGE 파티션. 마이그레이션이 당월+익월을 생성한다.
- **매월 익월 파티션을 선생성해야 한다**: `SELECT audit.create_partition((now() + interval '1 month')::date);`
  - WP-6b에서 스케줄 워커에 편입 예정. 그 전까지는 월 1회 수동 실행.
- append-only 강제(애플리케이션 DB 계정의 UPDATE/DELETE 권한 제거)는 WP-6b 마이그레이션에서 적용한다.
