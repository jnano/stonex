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
| `domains` 부분 유니크 `uq_domains_fqdn_live` (WHERE deleted_at IS NULL) | `20260808014055_domain_verification` |
| `domains` 부분 인덱스 `idx_domains_owner` (WHERE deleted_at IS NULL) | `20260808014055_domain_verification` |
| `domain_verification_attempts` 부분 유니크 `uq_domain_verification_inflight` (WHERE state IN PENDING/RUNNING) | `20260808014055_domain_verification` |
| `domain_verification_attempts.state` CHECK (PENDING\|RUNNING\|SUCCEEDED\|FAILED) | `20260808014055_domain_verification` |
| `domain_transfers` 부분 유니크 `uq_domain_transfers_pending` (WHERE status='PENDING') | `20260808021744_domain_transfers` |
| `domain_transfers.status` CHECK (PENDING\|ACCEPTED\|CANCELLED\|EXPIRED\|INVALIDATED) | `20260808021744_domain_transfers` |
| `domain_transfers` 자기이전 금지 CHECK (from_user_id <> to_user_id) | `20260808021744_domain_transfers` |
| `audit.audit_checkpoints` + `day_digest`·`chain_digest` 함수 (Prisma 모델 없음) | `20260808030000_audit_checkpoints` |
| `governance_freezes` 부분 유니크 `uq_governance_freezes_active` (WHERE status='ACTIVE') | `20260808035001_governance_freezes` |
| `governance_freezes.status` CHECK (ACTIVE\|RELEASED) | `20260808035001_governance_freezes` |
| `governance_freezes` 자기해제 금지 CHECK (released_by <> user_id) | `20260808035001_governance_freezes` |
| `audit_logs` 조회 인덱스 2종 (actor·action) | `20260808050000_audit_query_indexes` |
| `email_change_requests` 부분 유니크 `uq_email_change_pending` (WHERE status='PENDING') | `20260808061023_email_change_requests` |
| `email_change_requests.status` CHECK (PENDING\|CONFIRMED\|CANCELLED\|EXPIRED) | `20260808061023_email_change_requests` |
| `system_settings` 값 형태 CHECK (비밀이면 value NULL, 아니면 secret_value NULL) | `20260808085951_system_settings` |
| board 모듈 FK 전체 (커널 모델에 관계 미선언 — OQ-2) | `20260808150000_board_core_constraints` |
| `boards.visibility`·`boards.status`·`posts.status`·`comments.status` CHECK | `20260808150000_board_core_constraints` |
| `posts` 부분 인덱스 3종 (board_created·pinned·owner) + `comments` owner 부분 인덱스 | `20260808150000_board_core_constraints` |
| `posts.search_tsv` GENERATED 컬럼 + GIN 인덱스 (§8) | `20260808150000_board_core_constraints` |
| `board_touch_updated_at()` 트리거 3종 (updated_at 은 DB 가 관리) | `20260808150000_board_core_constraints` |
| board WP-B3 FK 전체 (outbox·notifications·reactions·tags) | `20260809010000_board_interaction_constraints` |
| pg_trgm 확장 + posts trgm GIN 2종 + view_count (GD-3 어댑터 — pg_bigm 은 환경 부재로 pg_trgm 채택) | `20260809020000_board_search` |

## 업로드 세션 (`file_uploads`)

서명 URL 발급 시점의 조건(요청자·storage_key·MIME·크기 상한·만료)을 서버가 보관하는 테이블.
완료 콜백은 **불투명 `upload_id` 만** 받는다 — `storage_key` 를 클라이언트에 노출하면 §10.2 위반이자
타인의 오브젝트를 지목해 자기 파일 행을 만드는 경로가 열린다.
만료된 미완료 세션은 `UploadSessionService.collectGarbage()`(매시 20분)가 오브젝트와 함께 정리한다.

## 도메인 FQDN 유일성 (WP-12)

`domains` 의 `(tenant_id, fqdn)` 유일성은 **전체 유니크가 아니라 부분 유니크**(`WHERE deleted_at IS NULL`)다.
전체 유니크로 두면 소프트 삭제된 행이 슬롯을 계속 점유해 **같은 도메인을 영원히 재등록할 수 없다.**

부분 유니크는 바이트 단위 비교이므로, **애플리케이션이 항상 정규형으로 저장하는 것이 전제다**
(`apps/api/src/domains/fqdn.ts` — 소문자·후행 점 제거·punycode). 정규화를 건너뛰면
`EXAMPLE.com` 과 `example.com` 이 별개 행이 되어 중복 방지가 무력화되고, 같은 도메인을
두 사람이 각각 `VERIFIED` 로 만들 수 있다.

## 도메인 검증 잡 (`domain_verification_attempts`)

검증 시도 기록과 **잡 큐를 겸하는** 테이블이다. 실패 사유를 감사 로그에 넣지 않는 이유는,
검증 실패의 대부분이 사용자의 DNS 설정 오류라 빈도가 높아 권한 변경 기록을 덮어 버리기 때문이다.
`DomainVerificationService` 의 워커(10초 간격)가 `FOR UPDATE SKIP LOCKED` 로 PENDING 행을 선점한다.

## 도메인 소유자 이전 (`domain_transfers`, WP-13)

발의 + 수락의 2단계이며 상태는 **전적으로 이 신규 테이블에** 담는다(INV-7 — 기존 테이블 무변경).

- 동시 발의는 `(domain_id) WHERE status='PENDING'` 부분 유니크로 1건만 허용한다.
- **만료 처리는 이중이다**: 발의 시점의 지연 만료(`propose`)와 일 1회 스윕 크론.
  한쪽만 두면, 만료된 채 PENDING 으로 남은 발의 하나가 그 도메인의 재발의를 영구히 막는다.
- 수락 경로는 §7.3의 **인증 게이트형**이라 평가기가 실행되지 않는다.
  검증은 `PolicyService.canAcceptTransfer` 가 도메인 행을 `FOR UPDATE` 로 잠근 뒤 재현한다.
- 수락 시 **ALLOW Grant 는 삭제, DENY Grant 는 승계**한다 — DENY 를 함께 지우면
  소유권 왕복만으로 제재가 해제된다.

## L-2 권한 변경 동결 (`governance_freezes`, WP-14b)

이상 정황이 잡힌 계정의 **권한 변경 기능만** 묶는다 — 로그인·파일 업로드·도메인 사용은 그대로다.
계정 정지(`users.status`)와 다른 축이며 기존 테이블을 건드리지 않는다(INV-7).

- **동결 대상은 라우트 목록이 아니라 Permission 집합**이다(`FROZEN_PERMISSIONS`). 라우트로 두면
  새 API 를 추가할 때 조용히 누락된다. 집합은 시드에서 `*.share(.all)` + 역할 부여 + 매핑 편집으로
  기계적으로 도출한다.
- 강제 지점은 **Guard(HTTP 경로) + 권한 변경 서비스 진입부** 두 겹이다. 시스템 행위(actorId=null)는
  대상이 아니다 — 시스템을 동결하면 이상 상황에서 정리 자체가 멈춘다.
- 해제는 **피동결자 본인을 제외한** 활성 SUPER_ADMIN 1인이 승인한다. DB CHECK 로도 자기해제를 막는다.
  승인 가능 인원이 0명이면 break-glass 런북으로 넘어간다.

## 운영 설정은 DB 에서 온다 (`system_settings`)

이 프로젝트는 **내려받은 사람이 자기 환경에 맞춰 쓰는 것**을 전제한다. 접속 정보를 환경 변수로만
받으면 설정을 바꿀 때마다 배포 파일을 고치고 재기동해야 하는데, 그건 코드를 다룰 줄 아는
사람에게만 열린 문이다. 그래서 SMTP·파일 저장소 같은 운영 설정은 관리 화면에서 주입한다.

**환경 변수로 남는 것은 셋뿐이다** — 취향이 아니라 순서 때문이다.

| 변수 | 이유 |
|---|---|
| `DATABASE_URL` | DB 에 접속해야 설정을 읽는다. DB 주소를 DB 에 둘 수 없다 |
| `SETTINGS_ENCRYPTION_KEY` | 비밀값을 푸는 열쇠. 같은 DB 에 두면 자물쇠 옆에 열쇠를 두는 셈이다 |
| `JWT_SECRET` | 토큰 서명 루트. DB 가 털렸을 때 최후 방어선이 남으려면 분리되어야 한다 |

- 비밀값은 **AES-256-GCM** 으로 암호화해 `secret_value` 에 담고 **응답으로 절대 되돌려주지 않는다**.
  GCM 을 쓰는 이유는 변조 탐지다 — 설정값은 접속 대상을 정하므로 무결성이 기밀성만큼 중요하다.
- **환경 변수 폴백은 없다.** 두 곳에서 읽으면 "화면에는 A 인데 실제로는 B" 상태가 생기고
  그걸 추적하기가 매우 어렵다. 개발·CI 는 `scripts/seed-settings.ts` 로 DB 에 심는다
  (런타임 폴백이 아니라 프로비저닝이다).

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
## append-only 강제 (§10.3, WP-6b)

`20260807140000_audit_append_only` 마이그레이션이 애플리케이션 전용 역할 `stonex_app` 을 만들고,
`audit.audit_logs` 에 대해 **SELECT·INSERT 만** 부여한다(UPDATE/DELETE/TRUNCATE 없음).

- **운영 배포 시 애플리케이션은 반드시 `stonex_app` 역할로 접속해야 한다.** 슈퍼유저로 접속하면
  이 제약이 적용되지 않아 append-only 보증이 사라진다.
- 보존 기간 경과 파티션의 아카이브·분리는 관리자 계정의 별도 절차로만 수행한다.
- 검증: `apps/api/test/audit-ops.integration.spec.ts` 가 `SET LOCAL ROLE stonex_app` 으로
  UPDATE/DELETE 가 DB 수준에서 거부됨을 실증한다.

## break-glass 비상 회수

`SUPER_ADMIN` 탈취 시의 유일한 회수 경로. 절차서는 `docs/.../break-glass-runbook-v1.md`,
모의 실행 스크립트는 `scripts/breakglass-drill.sh`(분기 1회 실행 권장).

## 테스트는 직렬 실행한다 (`jest --runInBand`)

통합 테스트는 하나의 테스트 DB를 공유한다. 병렬 실행하면 스펙끼리 서로의 데이터를 건드려
**테스트가 아니라 실행 순서가 결과를 정한다.** 실제로 두 번 물렸다.

1. 두 스펙이 같은 테넌트 UUID를 써서 한쪽의 `afterAll` 이 다른 쪽 데이터를 지웠다.
2. 순찰 스펙의 L-1 자동 회수가 **다른 스펙의 Grant** 를 고아로 판정해 회수했다
   (불변식은 전 테넌트를 훑는다 — 이것이 정상 동작이다).

직렬 실행은 이 두 부류를 한 번에 없앤다. 그리고 실측상 **더 빠르다**(50초 vs 70초) —
워커들이 같은 DB 커넥션을 두고 경합하던 비용이 병렬 이득보다 컸다.
스펙별 전용 테넌트 UUID 규칙은 그대로 유지한다(직렬이어도 잔여 데이터 추적이 쉬워진다).
