# break-glass 비상 회수 절차 (운영 런북)

| 항목 | 내용 |
|---|---|
| 문서 버전 | v1 |
| 작성일 | 2026-08-07 |
| 근거 | `permission-system-spec-v1.6.md` §10.1·§16.3-1, `phase1-work-order-v4.md` WP-6b (RT-1) |
| 적용 대상 | 탈취·오작동한 `SUPER_ADMIN` 계정의 무력화 |
| 상태 | Phase 1 산출물. 스테이징 모의 실행 완료(§6) |

---

## 1. 이 절차가 존재하는 이유

권한 시스템은 관리 행위를 **우위 검사**(행위자 권한 집합 ⊋ 대상자 권한 집합, 기획서 §4.6-1)로 통제한다. `SUPER_ADMIN` 끼리는 권한 집합이 동일하므로 상호 관리가 거부된다 — **이는 의도된 동작**(동급 관리자 상호 공격 차단)이며, 그 파생으로 **탈취된 `SUPER_ADMIN` 을 시스템 내 정상 경로로 무력화할 수 없다.**

따라서 비상 회수는 시스템 **밖**의 통제된 절차로만 수행한다. 이 절차는 기획서 §16.3-1 "운영 DB 직접 수정 금지"의 **유일하게 승인된 예외**다.

Phase 3에서 쿼럼 승인 구조(§9.5)가 도입되면 시스템 내 경로가 생기지만, 활성 `SUPER_ADMIN` 이 2인 이하이면 쿼럼이 성립하지 않으므로 **본 절차는 그 이후에도 최후 수단으로 유지**한다.

## 2. 발동 요건 (아래 중 하나 + 승인)

- `SUPER_ADMIN` 계정 자격 증명 유출·탈취가 확인되거나 강하게 의심됨
- `SUPER_ADMIN` 계정이 악의적·오작동으로 권한 구조를 훼손 중
- 활성 `SUPER_ADMIN` 이 0이 되어 시스템이 잠김 (RI-1 위반)

**승인**: 서비스 책임자 1인의 구두/메신저 승인으로 착수할 수 있다. 사후 보고(§5)는 필수다.

## 3. 원칙 (모든 단계에 적용)

1. **2인 입회**: 실행자와 입회자 2인이 함께 수행한다. 단독 실행 금지 — 이 절차 자체가 권한 우회이므로 상호 감시가 유일한 통제다.
2. **전용 계정**: 평시 로그인 불가 상태(`NOLOGIN`)인 `stonex_breakglass` 역할을 일시 활성화해 사용한다. 애플리케이션 계정(`stonex_app`)으로는 수행하지 않는다.
3. **전량 감사**: 실행 전·후 상태와 모든 조치를 감사 로그에 남긴다. 감사 로그는 append-only 이므로 이 기록은 사후에 수정할 수 없다.
4. **사후 전 세션 무효화**: 조치 후 전 사용자의 `perm_version` 을 증가시켜 유효 세션을 모두 끊는다. 탈취자가 이미 발급받은 토큰을 무력화하기 위함이다.
5. **최소 조치**: 목적(대상 계정 무력화)에 필요한 최소 변경만 한다. 데이터 정리·구조 변경은 이 절차로 하지 않는다.

## 4. 실행 절차

### 4.0 준비

```bash
# 실행자·입회자·사유·시각을 먼저 기록한다 (사후 보고서의 원자료)
export BG_ACTOR="실행자 이름"
export BG_WITNESS="입회자 이름"
export BG_REASON="SUPER_ADMIN 계정 <이메일> 탈취 정황"
export TARGET_EMAIL="탈취된 계정 이메일"
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

### 4.1 전용 계정 활성화

```sql
-- 관리자(슈퍼유저) 접속으로 수행
ALTER ROLE stonex_breakglass LOGIN PASSWORD '<일회용 강한 비밀번호>' VALID UNTIL 'now() + interval ''2 hours''';
```

### 4.2 조치 전 상태 기록

```sql
-- 대상 계정과 현재 활성 SUPER_ADMIN 목록을 남긴다
SELECT u.id, u.email, u.status, r.code, ur.expires_at
FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id
WHERE r.code = 'SUPER_ADMIN';
```

### 4.3 조치 (전용 계정으로 접속)

```sql
BEGIN;

-- (1) 조치 전 스냅샷을 감사 로그에 기록
INSERT INTO audit.audit_logs (tenant_id, actor_id, action, target_type, target_id, detail)
SELECT u.tenant_id, NULL, 'breakglass.begin', 'user', u.id,
       jsonb_build_object('actor', :'BG_ACTOR', 'witness', :'BG_WITNESS',
                          'reason', :'BG_REASON',
                          'before', jsonb_build_object('status', u.status))
FROM users u WHERE u.email = :'TARGET_EMAIL';

-- (2) 대상 계정 정지 + SUPER_ADMIN 역할 회수
UPDATE users SET status = 'SUSPENDED', perm_version = perm_version + 1
WHERE email = :'TARGET_EMAIL';

DELETE FROM user_roles ur
USING users u, roles r
WHERE ur.user_id = u.id AND ur.role_id = r.id
  AND u.email = :'TARGET_EMAIL' AND r.code = 'SUPER_ADMIN';

-- (3) 대상 계정의 모든 리프레시 토큰 폐기
UPDATE refresh_tokens SET revoked_at = now()
WHERE user_id = (SELECT id FROM users WHERE email = :'TARGET_EMAIL') AND revoked_at IS NULL;

-- (4) 불변식 확인: 활성 SUPER_ADMIN 이 최소 1인 남아야 한다 (RI-1)
--     0이면 즉시 ROLLBACK 하고 §4.5 로 간다 (다른 관리자 승격이 선행되어야 함)
SELECT count(*) AS remaining FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id
WHERE r.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE'
  AND (ur.expires_at IS NULL OR ur.expires_at > now());

-- (5) 조치 후 상태를 감사 로그에 기록
INSERT INTO audit.audit_logs (tenant_id, actor_id, action, target_type, target_id, detail)
SELECT u.tenant_id, NULL, 'breakglass.end', 'user', u.id,
       jsonb_build_object('actor', :'BG_ACTOR', 'witness', :'BG_WITNESS',
                          'after', jsonb_build_object('status', u.status, 'super_admin_revoked', true))
FROM users u WHERE u.email = :'TARGET_EMAIL';

COMMIT;
```

### 4.4 전 세션 강제 무효화

```sql
-- 전 사용자 perm_version 증가 → 발급된 모든 Access Token 이 pv 불일치로 거부된다(§8.3)
UPDATE users SET perm_version = perm_version + 1;
UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL;
```

> 전 사용자 재로그인이 발생한다. 이는 의도된 비용이다 — 탈취자가 어느 세션을 쥐고 있는지 알 수 없기 때문이다.

### 4.5 활성 `SUPER_ADMIN` 이 0이 되는 경우

대상이 유일한 `SUPER_ADMIN` 이었다면, **먼저** 신뢰할 수 있는 계정에 `SUPER_ADMIN` 을 부여한 뒤 §4.3을 수행한다.

```sql
INSERT INTO user_roles (tenant_id, user_id, role_id)
SELECT u.tenant_id, u.id, r.id FROM users u, roles r
WHERE u.email = '<신규 관리자 이메일>' AND r.code = 'SUPER_ADMIN'
  AND u.tenant_id = r.tenant_id;
-- 이 부여도 audit.audit_logs 에 breakglass.grant 로 기록할 것
```

### 4.6 전용 계정 재비활성화 (필수)

```sql
ALTER ROLE stonex_breakglass NOLOGIN;
ALTER ROLE stonex_breakglass PASSWORD NULL;
```

## 5. 사후 보고 (24시간 이내)

다음을 보고서로 남기고 서비스 책임자에게 전달한다.

| 항목 | 내용 |
|---|---|
| 발동 시각·종료 시각 | UTC |
| 실행자 / 입회자 | 이름 |
| 사유 | 탈취 정황·근거 |
| 조치 내역 | 정지·회수·세션 무효화 범위 |
| 감사 로그 참조 | `breakglass.begin` / `breakglass.end` 행 id |
| 영향 | 재로그인 발생 사용자 수, 서비스 영향 시간 |
| 후속 조치 | 자격 증명 재발급, 침해 경로 조사, 재발 방지책 |

조회:

```sql
SELECT id, created_at, action, target_id, detail
FROM audit.audit_logs WHERE action LIKE 'breakglass.%' ORDER BY created_at DESC;
```

## 6. 모의 실행 기록 (WP-6b DoD)

| 항목 | 내용 |
|---|---|
| 일시 | 2026-08-07 |
| 환경 | 스테이징 상당 (로컬 PostgreSQL 16.13, DB `stonex_test`) |
| 시나리오 | 임시 `SUPER_ADMIN` 계정 생성 → §4.1~4.6 전 절차 수행 |
| 결과 | 성공 — 대상 정지·역할 회수·토큰 폐기·전 세션 무효화 확인, `breakglass.begin`/`breakglass.end` 감사 로그 2건 기록 확인, 전용 계정 재비활성화 확인 |
| 검증 스크립트 | `scripts/breakglass-drill.sh` (반복 실행 가능, 종료 시 테스트 데이터 정리) |

정기 재실행: **분기 1회** 모의 실행을 권장한다. 절차가 실제로 동작하지 않는 런북은 없는 것과 같다.

## 7. 한계 (정직성 조항)

- 이 절차는 **DB 접근 권한을 가진 사람**을 신뢰한다. 그 권한 자체가 침해되면 이 절차도 무력하다 — DB 접근 통제·감사는 별도 계층의 책임이다.
- 2인 입회는 기술적으로 강제되지 않는다(운영 규율). 기술적 강제가 필요해지면 Phase 3 쿼럼 승인 구조(§9.5)가 그 역할을 한다.
- 감사 로그는 append-only 이나, DB 슈퍼유저는 여전히 파티션을 조작할 수 있다. 완전한 변조 방지가 필요하면 외부 append-only 저장소로의 이중 기록이 추가로 필요하다.

---

*문서 끝.*
