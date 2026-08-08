# Phase 2 롤백 절차 (WP-15, WT-22)

Phase 2 는 신규 테이블·외부 의존(DNS·스토리지)·**파괴적 자동 조치**(순찰 L-1)가 한꺼번에
들어온다. 되돌리는 절차 없이 이런 조합을 배포하면, 문제가 생겼을 때 선택지가 "전체 롤백"
하나뿐이 되어 오히려 아무도 되돌리지 못한다.

되돌림은 **세 층**으로 나눠 둔다. 위험이 큰 것부터 순서대로 끄면 되고, 대개 1층으로 끝난다.

---

## 1층. 기능 비활성 플래그 (재배포 없이 즉시)

환경 변수만 바꾸고 프로세스를 재시작하면 된다. **DB 는 건드리지 않는다.**

| 증상 | 끄는 것 | 방법 |
|---|---|---|
| 순찰이 정상 Grant 를 회수한다 | L-1 자동 조치 | `PATROL_BLAST_RADIUS_ROWS=0` — 모든 조치가 상한 초과로 판정되어 **L-2 승격(보고)만** 하고 삭제하지 않는다 |
| 순찰이 DB 를 압박한다 | 순찰 전체 | `PATROL_CRON='0 0 31 2 *'` (존재하지 않는 날짜 — 실질적 비활성) |
| DNS 검증이 외부 지연을 유발한다 | 검증 워커 | `DOMAIN_VERIFY_BATCH=0` — 잡은 쌓이되 처리하지 않는다 |
| 감사 조회가 DB 를 점유한다 | 조회 범위 | `AUDIT_QUERY_MAX_DAYS=7` |
| 업로드가 스토리지 장애를 부른다 | 업로드 | 스토리지 자격 제거 후 `/health/ready` 가 실패로 전환되면 로드밸런서가 뺀다 |
| 이상 탐지 알림이 과다하다 | 탐지 주기 | `ANOMALY_*` 임계 상향 |

**확인 방법**: `GET /admin/governance/status` 의 `remediated`·`escalated` 로 자동 조치가
멈췄는지 본다. `healthy=false` 면 순찰 자체가 멎은 것이다.

---

## 2층. 데이터 복구 (조치가 이미 일어난 뒤)

### L-1 이 회수한 Grant 되살리기

```bash
# 미리보기 (기본)
pnpm tsx scripts/restore-grants.ts --since 2026-08-08T00:00:00Z --ri RI-3
# 실제 적용
pnpm tsx scripts/restore-grants.ts --since 2026-08-08T00:00:00Z --ri RI-3 --apply
```

회수 전 행 **전체**가 감사 로그 `detail.before` 에 남아 있어 원래 id 로 복원된다.
이미 같은 (주체·리소스·권한) 조합이 있으면 건너뛰므로 재실행해도 안전하다.

### L-2 동결 일괄 해제

동결은 데이터를 지우지 않으므로 해제만 하면 원상 복구된다.

```sql
-- 승인자 기록을 남기려면 API(POST /admin/governance/freezes/:id/release)를 쓴다.
-- 비상 시에만 직접 실행하고, 실행 사실을 별도로 기록한다.
UPDATE governance_freezes SET status='RELEASED', released_at=now(),
       release_note='비상 일괄 해제'
 WHERE status='ACTIVE' AND frozen_at > '<사고 시각>';
```

---

## 3층. 스키마 되돌리기 (마지막 수단)

Phase 2 는 **기존 테이블의 컬럼을 하나도 바꾸지 않았다**(INV-7). 그래서 되돌림은
"신규 테이블·인덱스 제거"로 끝나며, Phase 1 데이터는 그대로 남는다.

`db/rollback/phase2-down.sql` 을 순서대로 적용한다. **이 파일은 `db/migrations/` 밖에 둔다** —
안에 두면 Prisma 가 마이그레이션 디렉터리로 오인해 `migrate deploy` 자체가 실패한다(리허설에서 발견). **이 스크립트는 데이터를
삭제하므로, 실행 전에 반드시 `pg_dump` 를 뜬다.**

```bash
pg_dump -U <user> <db> -n public -n audit -f phase2-backup-$(date +%s).sql
psql -U <user> -d <db> -f db/rollback/phase2-down.sql
```

되돌린 뒤에는 `prisma migrate resolve --rolled-back <migration>` 으로 마이그레이션
이력을 맞춰야 다음 배포가 충돌하지 않는다.

---

## 리허설 기록

롤백은 **해 본 적 없는 절차가 가장 위험하다.** 스테이징에서 1회 이상 실제로 수행하고
아래 표에 기록한다. 기록이 비어 있으면 릴리스 판정을 통과시키지 않는다.

| 일자 | 수행자 | 범위 | 소요 | 결과·발견 |
|---|---|---|---|---|
| 2026-08-08 | 구현 담당 | 3층(스키마 되돌리기) — 실 DB 사본 | 4초 | 마이그레이션 전량 적용 + 시드 후 `phase2-down.sql` 실행. **테이블 20→15, Permission 31→26, Phase 2 신규 테이블 5종 잔존 0**, `users` 행 수 불변(INV-7 실증) |
| 2026-08-08 | 구현 담당 | 1층(플래그) | 즉시 | `PATROL_BLAST_RADIUS_ROWS=0` 이 모든 L-1 조치를 상한 초과로 만들어 **삭제 없이 L-2 승격만** 하는 것을 순찰 테스트로 확인 |

**리허설에서 발견해 고친 것**

1. `phase2-down.sql` 을 `db/migrations/` 안에 두었더니 **Prisma 가 마이그레이션 디렉터리로 오인해
   `migrate deploy` 자체가 실패**했다("Could not find the migration file at migration.sql").
   `db/rollback/` 으로 옮겼다. 리허설을 하지 않았다면 다음 배포에서야 드러났을 문제다.
2. 복구 스크립트는 **미리보기가 기본**이라 `--apply` 없이 실행하면 아무 일도 일어나지 않는다.
   비상 상황에서 "실행했는데 왜 안 되지"로 시간을 잃지 않도록 절차서 본문에 명시했다.

> 운영 스테이징에서의 리허설은 배포 담당이 같은 표에 이어서 기록한다.
