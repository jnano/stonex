# 권한 관리 웹 애플리케이션 기획서

| 항목 | 내용 |
|---|---|
| 문서 버전 | v1.4 |
| 작성일 | 2026-08-07 |
| 상태 | 초안 — SUPER_ADMIN 비상 회수 경로(break-glass·쿼럼) 확정 반영 (변경 내역은 §17) |
| 대상 도메인 | 회원(Member) · 파일(File) · 도메인(Domain) |
| 권한 모델 | 하이브리드 (RBAC 뼈대 + 권한 집합 우위 비교 + 리소스 단위 Grant 확장) |
| 서비스 형태 | 단일 서비스로 시작, 멀티테넌트 확장 지점 사전 반영 |

---

## 1. 문서 개요

### 1.1 목적

본 문서는 회원·파일·도메인 리소스를 관리하는 웹 애플리케이션의 권한 시스템을 정의한다. 권한 시스템은 애플리케이션의 기반 계층(Foundation Layer)으로 설계하며, 이후 추가되는 모든 기능 모듈이 코드 수정 없이 권한 체계에 편입될 수 있는 확장성을 최우선 설계 목표로 한다.

### 1.2 범위

- 포함: 권한 모델, 데이터 모델, 인증/세션, 권한 평가 알고리즘, 회원/파일/도메인 기능 명세, API 설계, 관리자 콘솔, 확장 지점, 보안 정책, 구현 로드맵
- 제외: UI 시안, 결제, 알림 등 부가 기능의 상세 명세 (단, 이들이 권한 체계에 편입되는 절차는 §9에서 정의)

### 1.3 용어 정의

| 용어 | 정의 |
|---|---|
| Permission (권한) | 시스템이 허용/거부를 판단하는 최소 단위의 행위. 문자열 코드로 식별한다. 예: `file.delete` |
| Role (역할) | Permission의 집합. 사용자에게는 Role만 부여한다. 예: `FILE_MANAGER` |
| Dominance (우위) | 관리 서열의 판정 기준. 사용자 A의 유효 Permission 집합이 B의 유효 Permission 집합을 **진부분집합으로 포함**(A ⊋ B)할 때 "A가 B에 대해 우위"라 한다. 별도의 등급 숫자 없이 권한 데이터에서 파생된다 |
| display_order (표시 순서) | Role의 UI 정렬·표시 전용 정수. **어떤 권한·관리 규칙에도 사용을 금지**한다 |
| Grant (개별 부여) | 특정 사용자에게 특정 리소스 단위로 부여되는 예외적 권한. 예: "사용자 B에게 파일 X의 읽기 권한" |
| Subject (주체) | 권한 평가의 대상. Phase 1에서는 사용자(User)만 해당하며, 이후 API Key·서비스 계정으로 확장한다 |
| Scope (범위) | 권한이 유효한 경계. Phase 1에서는 전역(global) 단일 범위이며, 멀티테넌트 확장 시 테넌트 단위로 분화한다 |

### 1.4 설계 불변 규칙 (Invariants)

아래 규칙은 구현 전 기간에 걸쳐 위반을 금지한다. 코드 리뷰 시 본 절을 기준으로 검사한다.

1. **INV-1. 권한 검사는 Permission 코드로만 수행한다.** 애플리케이션 코드 어디에서도 `role === 'ADMIN'`, `display_order >= 30` 형태의 검사를 금지한다. 허용되는 유일한 형태는 `can(subject, permissionCode, resource?)` 이다.
2. **INV-2. 관리 서열은 데이터에서 파생한다.** 등급 숫자·레벨 등 별도의 서열 필드를 보안 규칙에 도입하지 않는다. "누가 누구를 관리할 수 있는가"는 오직 권한 집합 우위 비교(§4.6)로 판정하며, `display_order`는 표시·정렬 외의 용도로 사용을 금지한다.
3. **INV-3. 사용자에게 Permission을 직접 부여하지 않는다.** 사용자에게는 Role 또는 리소스 단위 Grant만 연결한다. 전역 권한이 필요하면 Role을 만든다.
4. **INV-4. 명시적 거부(DENY)는 모든 허용(ALLOW)에 우선한다.**
5. **INV-5. 기본값은 거부(Default Deny)이다.** 어떤 규칙에도 해당하지 않는 요청은 거부한다. 권한 검사가 누락된 API는 미들웨어 수준에서 차단한다.
6. **INV-6. 모든 권한 변경은 감사 로그(Audit Log)에 기록한다.** 기록 실패 시 권한 변경 트랜잭션 자체를 롤백한다.
7. **INV-7. 새 기능 모듈 추가 시 기존 테이블 스키마를 변경하지 않는다.** Permission 행 추가와 Role 매핑 추가만으로 편입되어야 한다.

---

## 2. 시스템 개요

### 2.1 서비스 형태

하나의 조직이 운영하는 단일 웹 서비스로 출발한다. 회원이 가입하여 파일을 업로드·공유하고, 관리 권한을 가진 회원이 회원·파일·도메인을 관리한다. 멀티테넌트(B2B) 전환 가능성을 고려하여, 모든 권한 관련 테이블에 확장 지점(§9.2)을 사전 반영하되 Phase 1에서는 활성화하지 않는다.

### 2.2 관리 대상 리소스

| 리소스 | 설명 | 리소스 단위 Grant 지원 |
|---|---|---|
| Member | 서비스 가입자 계정. 프로필, 상태(활성/정지/탈퇴), 역할 보유 | 미지원 (전역 권한으로만 관리) |
| File | 사용자가 업로드하는 파일. 소유자 개념 존재 | 지원 (파일 단위 공유) |
| Domain | 서비스에 등록·관리되는 도메인 엔터티(예: 고객 보유 도메인, 연결 도메인). 소유자 개념 존재 | 지원 (도메인 단위 위임) |

### 2.3 액터 정의

| 액터 | 설명 | 초기 부여 역할 |
|---|---|---|
| 비회원 | 미인증 방문자 | (없음) — 공개 리소스만 접근 |
| 일반회원 | 가입 완료 사용자 | `MEMBER` |
| 파일관리자 | 파일 리소스 전담 운영자 | `FILE_MANAGER` |
| 도메인관리자 | 도메인 리소스 전담 운영자 | `DOMAIN_MANAGER` |
| 운영자 | 회원·파일·도메인 전반 운영 | `OPERATOR` |
| 최고관리자 | 시스템 전체 및 역할·권한 편집 | `SUPER_ADMIN` |

액터는 예시 구성이며, 역할은 데이터로 정의되므로 운영 중 자유롭게 추가·수정할 수 있다(단, `SUPER_ADMIN`은 시스템 역할로 삭제 금지 — §10.3).

---

## 3. 기술 스택

| 계층 | 선정 기술 | 선정 근거 |
|---|---|---|
| 프론트엔드 | Next.js 15 (App Router, TypeScript) | 서버 컴포넌트 기반 권한별 UI 분기, 생태계 성숙도 |
| 백엔드 | NestJS 11 (TypeScript) | Guard/Decorator 구조가 권한 검사 계층화(§7.4)에 부합 |
| 데이터베이스 | PostgreSQL 16 | JSONB(확장 조건 필드), Row-Level Security(멀티테넌트 확장 대비), 파티셔닝(감사 로그) |
| ORM | Prisma | 스키마 선언형 관리, 마이그레이션 이력화 |
| 캐시 | Redis 7 | 권한 스냅샷 캐시(§8.3), 세션 무효화 브로드캐스트 |
| 파일 스토리지 | S3 호환 오브젝트 스토리지 (AWS S3 또는 MinIO) | 서명 URL 기반 다운로드 권한 통제 |
| 인증 | 자체 발급 JWT(Access) + Opaque Refresh Token | §8 참조 |
| 인프라 | Docker Compose(개발) → 컨테이너 오케스트레이션(운영) | 환경 일관성 |

프론트엔드의 권한 분기는 표시 목적에 한정한다. 모든 실제 통제는 백엔드에서 수행한다(프론트 검사는 UX 보조 수단이며 보안 경계가 아니다).

---

## 4. 권한 모델 설계

### 4.1 모델 구조 개관

권한 모델은 3계층으로 구성한다.

```
[계층 1] Permission  ─ 행위의 최소 단위 (예: file.delete)
     ▲ n:m
[계층 2] Role        ─ Permission의 묶음. 사용자에게 부여되는 단위
     ▲ n:m
       User
     ▲ 1:n
[계층 3] Grant       ─ (사용자, 리소스, Permission) 단위의 예외 부여
```

- 계층 1·2는 Phase 1에서 완전 구현한다.
- 계층 3은 Phase 1에서 테이블과 평가 로직까지 구현하되, 파일 공유 기능에서만 사용한다. 이후 기능은 동일 메커니즘을 재사용한다.

### 4.2 Permission 명명 규약

```
형식:  {리소스}.{행위}            예: member.read, file.upload
확장:  {모듈}.{리소스}.{행위}     예: billing.invoice.refund  (신규 모듈 편입 시)
```

- 리소스·행위는 소문자 단수형 영문으로 한다.
- 행위 표준 어휘: `read`(조회) / `create`(생성) / `update`(수정) / `delete`(삭제) / 리소스 고유 행위(`upload`, `download`, `share`, `ban`, `verify`, `transfer` 등)
- 와일드카드 `*`는 **역할-권한 매핑 시점의 편의 문법**으로만 허용한다. 매핑 저장 시 개별 Permission 행으로 전개(expand)하여 저장하며, 런타임 평가기에는 와일드카드가 도달하지 않는다.
  - 근거: 런타임 와일드카드 매칭은 신규 Permission 추가 시 의도하지 않은 자동 허용(권한 확대 사고)을 유발한다. 전개 저장 방식에서는 신규 Permission이 어떤 역할에도 자동 편입되지 않는다(Default Deny 유지).

### 4.3 Permission Scope (범위 속성)

모든 Permission은 `scope` 속성을 갖는다. 이는 평가기(§4.7)가 역할 보유 권한을 해석하는 방식을 결정하는 1급 개념이다.

| scope | 의미 | 평가 방식 |
|---|---|---|
| `global` | 대상 리소스와 무관하게 유효한 권한 | 역할이 보유하면 즉시 허용 |
| `owned` | **자신이 소유한 리소스에 한해** 유효한 권한 | 역할이 보유하고 **또한** `resource.owner_id = subject.id`일 때만 허용 |

이 분리로 "소유자 행위 집합"이라는 별도 정의가 불필요해진다 — 리소스 타입별 소유자 행위는 `scope='owned'`인 Permission 그 자체로 정의된다. 타인 소유 리소스에는 (a) `.all` 계열 `global` 권한 또는 (b) 리소스 Grant가 있어야 접근할 수 있다.

### 4.4 Phase 1 Permission 목록

| 코드 | scope | 설명 |
|---|---|---|
| `member.read` | global | 회원 목록·상세 조회 |
| `member.update` | global | 회원 정보 수정 |
| `member.role.assign` | global | 회원에게 역할 부여/회수 |
| `member.ban` | global | 회원 정지/해제 |
| `member.delete` | global | 회원 삭제(소프트 삭제) |
| `file.upload` | global | 파일 업로드 (생성 행위, 대상 리소스 없음) |
| `file.read` | owned | 소유 파일 조회·다운로드 |
| `file.update` | owned | 소유 파일 메타데이터 수정 |
| `file.delete` | owned | 소유 파일 삭제 |
| `file.share` | owned | 소유 파일 공유(Grant 생성/회수) |
| `file.read.all` | global | 전체 파일 접근 (관리자용) |
| `file.delete.all` | global | 전체 파일 삭제 (관리자용) |
| `domain.create` | global | 도메인 등록 (생성 행위) |
| `domain.read` | owned | 소유 도메인 조회 |
| `domain.update` | owned | 소유 도메인 설정 수정 |
| `domain.delete` | owned | 소유 도메인 삭제 |
| `domain.verify` | owned | 소유 도메인 소유권 검증 실행 |
| `domain.transfer` | owned | 소유 도메인 소유자 이전 발의 |
| `domain.read.all` | global | 전체 도메인 조회 (관리자용) |
| `domain.update.all` | global | 전체 도메인 수정 (관리자용) |
| `domain.delete.all` | global | 전체 도메인 삭제 (관리자용) |
| `domain.verify.all` | global | 전체 도메인 검증 실행 (관리자용) |
| `admin.role.read` | global | 역할·권한 정의 조회 |
| `admin.role.manage` | global | 역할 생성·수정·삭제, 역할-권한 매핑 편집 |
| `admin.audit.read` | global | 감사 로그 조회 |
| `system.settings.manage` | global | 시스템 설정 변경 |

리소스 Grant(계층 3)로 부여 가능한 Permission은 리소스 타입별 화이트리스트로 제한한다(§5.3): `file` → {`file.read`, `file.update`} / `domain` → {`domain.read`, `domain.update`, `domain.verify`}. `file.share`는 Grant 부여 대상에서 제외한다(재공유 전파 차단 — §10.1). 소유자 이전(`domain.transfer`)과 삭제는 Grant로 위임할 수 없다.

### 4.5 Role 정의

| 역할 코드 | 명칭 | display_order | 시스템 역할 | 보유 Permission |
|---|---|---|---|---|
| `MEMBER` | 일반회원 | 10 | O | `file.read`, `file.upload`, `file.update`, `file.delete`, `file.share`, `domain.read` |
| `FILE_MANAGER` | 파일관리자 | 30 | X | `MEMBER` 보유분 + `file.read.all`, `file.delete.all` |
| `DOMAIN_MANAGER` | 도메인관리자 | 30 | X | `MEMBER` 보유분 + `domain.create`, `domain.read.all`, `domain.update.all`, `domain.delete.all`, `domain.verify.all` |
| `OPERATOR` | 운영자 | 60 | X | 위 전부 + `member.read`, `member.update`, `member.ban`, `member.role.assign`, `member.delete`, `admin.audit.read` |
| `SUPER_ADMIN` | 최고관리자 | 100 | O | 전체 Permission |

- `display_order`는 관리 콘솔의 정렬·표시 전용 값이다. 보안 규칙 어디에도 사용하지 않는다(INV-2). 중복을 허용하며, 값의 크기는 아무 의미도 보증하지 않는다.
- "보유분 +"는 시드 데이터 구성 시의 서술 편의이며, 저장 구조상 역할 간 상속은 없다(각 역할에 Permission을 개별 매핑). 역할 상속은 의도적으로 배제한다 — 상속 체인은 권한 추적을 어렵게 하고 순환 참조 위험을 만든다. 재사용이 필요하면 관리 콘솔의 "역할 복제" 기능으로 해결한다.
- 한 사용자는 복수 역할을 보유할 수 있다(예: `FILE_MANAGER` + `DOMAIN_MANAGER`). 사용자의 **유효 Permission 집합**은 보유 역할 Permission의 합집합으로 정의한다.
- `SUPER_ADMIN` 역할 부여에는 `expires_at`(임시 부여)을 지정할 수 없다. 만료에 의한 최고관리자 소멸을 원천 차단하기 위함이다(§10.1).

### 4.6 관리 서열 규칙 (Dominance)

"누가 누구를 관리할 수 있는가"는 별도의 등급 숫자 없이 **권한 집합 비교**로 판정한다. 이전 판(v1.1)의 rank 규칙은 부분집합 검사와 중복이면서 예외 규칙(`SUPER_ADMIN` 부여 특례)을 낳아 제거하였다(§17). 유효 Permission 집합은 스냅샷 캐시(§8.3)에 있으므로 비교 비용은 정수 비교와 실질 차이가 없다.

1. **관리 행위 방어 (우위 검사)**: 사용자 A가 사용자 B에 대해 관리 행위(`member.update`, `member.ban`, `member.role.assign`, `member.delete`)를 수행하려면, Permission 검사 통과에 더해 **A의 유효 Permission 집합 ⊋ B의 유효 Permission 집합**(진부분집합 포함)이어야 한다. 집합이 같거나(동급 관리자 상호 공격 차단), 서로 비교 불가(각자 상대에게 없는 권한 보유)이면 거부한다. **본인을 대상으로 하는 역할 부여/회수는 전면 금지한다.** 이 규칙의 파생으로 `SUPER_ADMIN` 상호 간 관리 행위도 거부된다 — 따라서 탈취된 `SUPER_ADMIN`은 시스템 내 정상 경로로 무력화할 수 없으며, 비상 회수는 §10.1의 break-glass 절차(Phase 1)와 쿼럼 승인 구조(Phase 3, §9.5)가 담당한다.
2. **역할 부여 조건 (부분집합 검사)**: 사용자 A가 사용자 B에게 역할 R을 부여/회수하려면 **R의 Permission 집합 ⊆ A의 유효 Permission 집합**이어야 한다. 자신이 갖지 못한 권한이 담긴 역할은 부여할 수 없으므로, 공모 계정을 통한 간접 상승이 원천 차단된다. `SUPER_ADMIN`(전체 집합)은 이 규칙만으로 "기존 활성 `SUPER_ADMIN`만 부여 가능"이 자동 도출되어 별도 예외가 필요 없다. 단, `SUPER_ADMIN` 부여·회수는 감사 로그에 별도 심각도로 기록한다.
3. **판정 근거의 가시화**: 우위 판정은 데이터에서 파생되므로 운영자에게 직관적이지 않을 수 있다(상대가 내게 없는 권한 하나만 보유해도 관리 불가). 관리 콘솔은 회원 상세에서 "관리 가능/불가 + 사유(부족한 Permission 목록)"를 표시하고, 권한 시뮬레이터(ADM-5)가 동일 판정 로직을 재사용한다.

### 4.7 권한 평가 알고리즘 (Evaluator)

모든 권한 검사는 단일 함수 `can(subject, permission, resource?)`를 통과한다. 평가 순서는 다음과 같으며, 각 단계에서 결정되면 즉시 종료한다.

```
can(subject, permission, resource?) → ALLOW | DENY

  0. 주체 상태 검사
     subject.status ≠ ACTIVE → DENY          (정지·탈퇴 계정 전면 차단)

  1. 리소스 상태 검사 (resource가 주어진 경우)
     resource.status가 리소스 타입별 "접근 가능 상태" 집합에 없음 → DENY
       file:   {ACTIVE}
       domain: {UNVERIFIED, VERIFIED} + 조회(domain.read/read.all)에 한해 {SUSPENDED}
     소프트 삭제·정지된 리소스가 소유자/전역 권한 경로로 계속
     접근되는 것을 차단한다. (복구 기능 도입 시 복구 전용
     Permission만 이 게이트를 우회하도록 확장)

  2. 명시적 거부 검사 (INV-4)
     resource가 주어지고, (subject, resource, permission, effect=DENY)
     Grant가 존재 → DENY

  3. 역할 기반 허용 (scope 해석 — §4.3)
     permission이 subject의 유효 Permission 집합에 존재하고,
       permission.scope = global → ALLOW
       permission.scope = owned  → resource가 주어지고
                                   resource.owner_id = subject.id → ALLOW
     (owned 권한은 소유 리소스에만 유효하다. 이 구분이 없으면
      역할에 담긴 file.read가 전역 허용으로 오작동한다)

  4. 리소스 Grant 허용 (resource가 주어진 경우)
     (subject, resource, permission, effect=ALLOW) Grant가 존재하고
     만료되지 않음 → ALLOW

  5. DENY  (Default Deny, INV-5)
```

- 2단계 DENY 검사가 모든 허용 단계보다 앞서므로 INV-4가 보장된다.
- `owned` scope 권한의 소유자 판정과 Grant 조회는 리소스 로드를 전제한다. 리소스형 API는 핸들러 진입 전 리소스를 1회 로드하여 평가기와 핸들러가 공유한다(이중 조회 방지).
- 평가기는 백엔드 단일 모듈(`AuthorizationService`)로 구현하고, NestJS Guard가 이를 호출한다. 프론트엔드에는 동일 결과를 반영한 권한 스냅샷(§8.3)만 전달한다.

### 4.8 평가 예시

| 상황 | 결과 | 근거 단계 |
|---|---|---|
| `MEMBER` 철수가 자신이 올린 파일 삭제 | ALLOW | 3 (`file.delete`는 owned, 소유자 일치) |
| `MEMBER` 철수가 타인 파일 열람 | DENY | 5 (`file.read`는 owned인데 소유자 불일치, Grant 없음) |
| 타인 파일 X를 공유받은(`file.read` Grant) 철수가 X 열람 | ALLOW | 4 (Grant) |
| `FILE_MANAGER` 영희가 타인 파일 열람 | ALLOW | 3 (`file.read.all`은 global) |
| `FILE_MANAGER` 영희가 회원 정지 시도 | DENY | 5 (`member.ban` 미보유) |
| `OPERATOR` 민수가 `SUPER_ADMIN` 계정 정지 시도 | DENY | Permission은 통과하나 우위 검사(§4.6-1)에서 차단 |
| 철수가 자신의 삭제된(soft delete) 파일 다운로드 시도 | DENY | 1 (리소스 상태) |
| 정지된 계정이 아무 요청 | DENY | 0 |

---

## 5. 데이터 모델

### 5.1 ERD 개관

```
users ──< user_roles >── roles ──< role_permissions >── permissions
  │
  ├──< resource_grants >── (resource_type, resource_id 논리 참조)
  ├──< files
  ├──< domains
  └──< audit_logs
```

### 5.2 DDL (PostgreSQL 16)

주: `tenant_id`는 멀티테넌트 확장 지점(§9.2)이다. Phase 1에서는 모든 행이 고정값 `00000000-0000-0000-0000-000000000000`(기본 테넌트)을 가지며, 애플리케이션 코드에서 참조하지 않는다.

```sql
-- 확장 지점: 테넌트 (Phase 1에서는 기본 테넌트 1행만 존재)
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 회원
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  email          VARCHAR(255) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,          -- argon2id
  name           VARCHAR(100) NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
                 -- PENDING(이메일 미인증) | ACTIVE | SUSPENDED | DELETED
  perm_version   INTEGER      NOT NULL DEFAULT 1, -- 권한 스냅샷 무효화용 (§8.3)
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  UNIQUE (tenant_id, email)
);

-- 권한 (행위의 최소 단위)
CREATE TABLE permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(100) NOT NULL UNIQUE,      -- 예: 'file.delete'
  description VARCHAR(255) NOT NULL,
  scope       VARCHAR(10)  NOT NULL DEFAULT 'global'
              CHECK (scope IN ('global','owned')),  -- §4.3
  module      VARCHAR(50)  NOT NULL DEFAULT 'core', -- 기능 모듈 구분 (§9.1)
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- 권한은 코드 배포와 함께 시드로 관리한다. 관리 콘솔에서 임의 생성 불가(§10.3).

-- 역할
CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  code        VARCHAR(50)  NOT NULL,             -- 예: 'FILE_MANAGER'
  name        VARCHAR(100) NOT NULL,             -- 표시명: '파일관리자'
  display_order INTEGER    NOT NULL DEFAULT 0,  -- 정렬·표시 전용. 보안 규칙 사용 금지(INV-2)
  is_system   BOOLEAN      NOT NULL DEFAULT false, -- true면 삭제·코드변경 금지
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- 역할-권한 매핑
CREATE TABLE role_permissions (
  tenant_id     UUID NOT NULL REFERENCES tenants(id),  -- 확장 지점 (§9.2, RLS 대비)
  role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  granted_by    UUID REFERENCES users(id),
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

-- 사용자-역할 매핑
CREATE TABLE user_roles (
  tenant_id   UUID NOT NULL REFERENCES tenants(id),  -- 확장 지점 (§9.2, RLS 대비)
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by  UUID REFERENCES users(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,                       -- NULL이면 무기한 (임시 역할 지원)
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_user_roles_role ON user_roles (role_id);
-- 역할 보유자 전원 조회(§8.3 무효화, §10.3 삭제 전 검사)가 풀스캔이 되지 않도록 필수.
-- user·role의 tenant 일치는 서비스 계층 + 트리거로 이중 강제한다(교차 테넌트 부여 차단, §9.2).

-- 리소스 단위 개별 부여 (계층 3)
CREATE TABLE resource_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  subject_type   VARCHAR(20) NOT NULL DEFAULT 'USER',  -- 확장 지점: USER | API_KEY | GROUP
  subject_id     UUID NOT NULL,
  resource_type  VARCHAR(50) NOT NULL,                 -- 'file' | 'domain' | (이후 확장)
  resource_id    UUID NOT NULL,
  permission_id  UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect         VARCHAR(10) NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW','DENY')),
  conditions     JSONB,                                -- 확장 지점: ABAC 조건 (§9.3)
  granted_by     UUID NOT NULL REFERENCES users(id),
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,                          -- NULL이면 무기한
  UNIQUE (subject_type, subject_id, resource_type, resource_id, permission_id)
  -- effect는 UNIQUE에서 제외한다: 동일 (주체·리소스·권한)에 ALLOW와 DENY가
  -- 동시에 존재하는 자기모순 데이터를 원천 차단하고, effect는 행의 속성으로 갱신한다.
);
CREATE INDEX idx_grants_lookup
  ON resource_grants (subject_id, resource_type, resource_id);
CREATE INDEX idx_grants_resource
  ON resource_grants (resource_type, resource_id);   -- 리소스 삭제 시 정리용

-- 파일
CREATE TABLE files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  owner_id     UUID NOT NULL REFERENCES users(id),
  name         VARCHAR(255) NOT NULL,
  storage_key  VARCHAR(512) NOT NULL,            -- S3 오브젝트 키 (외부 노출 금지)
  size_bytes   BIGINT       NOT NULL,
  mime_type    VARCHAR(127) NOT NULL,
  checksum     VARCHAR(64)  NOT NULL,            -- SHA-256
  status       VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | DELETED
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_files_owner ON files (owner_id) WHERE status = 'ACTIVE';

-- 도메인
CREATE TABLE domains (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  owner_id      UUID NOT NULL REFERENCES users(id),
  fqdn          VARCHAR(253) NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'UNVERIFIED',
                -- UNVERIFIED | VERIFIED | SUSPENDED | DELETED
  verify_token  VARCHAR(64),                     -- DNS TXT 검증 토큰
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, fqdn)
);

-- 감사 로그 (월 단위 파티셔닝)
CREATE TABLE audit_logs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id     UUID NOT NULL,
  actor_id      UUID,                            -- NULL = 시스템 행위
  action        VARCHAR(100) NOT NULL,           -- 예: 'role.grant', 'file.share'
  target_type   VARCHAR(50),
  target_id     UUID,
  detail        JSONB NOT NULL DEFAULT '{}',     -- 변경 전/후 값
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 리프레시 토큰 (§8.2)
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   VARCHAR(64) NOT NULL UNIQUE,      -- SHA-256, 원문 미저장
  family_id    UUID NOT NULL,                    -- 재사용 탐지용 토큰 패밀리
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_family ON refresh_tokens (family_id);
CREATE INDEX idx_refresh_user   ON refresh_tokens (user_id);
```

### 5.3 데이터 규칙

- **소프트 삭제**: `users`, `files`, `domains`는 물리 삭제하지 않는다(`status` + `deleted_at`). 감사 추적성과 Grant 정리 일관성을 위함이다.
- **Grant 정리**: 리소스가 삭제(soft delete)되면 해당 리소스를 가리키는 `resource_grants`를 동일 트랜잭션에서 삭제한다. 사용자 삭제 시 해당 사용자가 subject인 Grant도 삭제한다. (논리 참조라 FK CASCADE가 불가능하므로 서비스 계층 책임으로 명시하고, 주 1회 배치로 고아 Grant를 검출·정리한다.)
- **`role_permissions.permission_id`의 `ON DELETE RESTRICT`**: Permission 삭제는 원칙적으로 금지한다. 폐기가 필요하면 시드에서 제거하기 전에 모든 역할 매핑을 먼저 회수해야 하며, 이 순서를 DB가 강제한다.
- **Grant 유효성 검증**: `resource_grants` 생성 시 서비스 계층에서 (a) `permission_id`가 해당 `resource_type`의 Grant 가능 화이트리스트(§4.4)에 속하는지, (b) 대상 리소스가 실제 존재하며 subject와 동일 테넌트인지 검증한다. 논리 참조는 FK가 없으므로 이 검증이 무결성의 유일한 방어선이다.

---

## 6. 기능 요구사항

기재 형식: `[식별자] 기능명 — 요구 Permission | 부가 규칙`

### 6.1 인증 (권한 검사 대상 아님)

- [AUTH-1] 회원가입 — 없음 | 이메일 인증 완료 시 `status=ACTIVE` 전환 및 `MEMBER` 역할 자동 부여
- [AUTH-2] 로그인 — 없음 | 실패 5회 시 15분 잠금. `status≠ACTIVE`면 로그인 거부
- [AUTH-3] 토큰 갱신 — 없음 | §8.2 회전 규칙 적용. **갱신 시점에 `status=ACTIVE`를 재검증**하며, 아니면 갱신 거부 + 해당 패밀리 폐기 (정지 계정의 토큰 발급 지속 차단)
- [AUTH-4] 비밀번호 재설정 — 없음 | 재설정 시 전체 리프레시 토큰 패밀리 폐기

### 6.2 회원 관리

- [MEM-1] 내 프로필 조회/수정 — 없음(본인 한정) | 본인 여부는 인증 컨텍스트로 판정. 이메일 변경 시 재인증
- [MEM-2] 회원 목록/상세 조회 — `member.read`
- [MEM-3] 회원 정보 수정 — `member.update` + 우위 검사(§4.6-1)
- [MEM-4] 회원 정지/해제 — `member.ban` + 우위 검사 | 정지 즉시 대상자의 `perm_version` 증가 + **리프레시 토큰 패밀리 전체 폐기** → 활성 세션·재발급 동시 차단(§8.3)
- [MEM-5] 역할 부여/회수 — `member.role.assign` + 우위 검사 + 부분집합 검사(§4.6-2) | `expires_at` 지정 가능(임시 역할, 단 `SUPER_ADMIN` 제외)
- [MEM-6] 회원 삭제 — `member.delete` + 우위 검사 | 소프트 삭제 + 리프레시 토큰 패밀리 전체 폐기. 소유 파일·도메인·Grant 처리 정책 동반 실행

### 6.3 파일 관리

- [FILE-1] 업로드 — `file.upload` | 서명 URL 발급 방식. 완료 콜백에서 checksum 검증
- [FILE-2] 내 파일 목록/다운로드 — `file.read`(소유자 단계로 통과) | 다운로드는 60초 만료 서명 URL로만 제공
- [FILE-3] 공유받은 파일 목록/다운로드 — Grant `file.read` | 목록은 `resource_grants` 역인덱스로 조회
- [FILE-4] 파일 공유 — `file.share`(소유자) 또는 `file.read.all`+`file.share`(관리자) | 공유 시 대상자·권한(`file.read`/`file.update`)·만료일 지정. 공유받은 자의 재공유는 금지(Grant는 `file.share`를 부여 대상에서 제외)
- [FILE-5] 공유 회수 — 공유 생성자 본인 또는 파일 소유자 | Grant 삭제 즉시 대상자 접근 차단
- [FILE-6] 파일 삭제 — `file.delete`(소유자) 또는 `file.delete.all` | Grant 동반 정리(§5.3)
- [FILE-7] 전체 파일 관리 목록 — `file.read.all`

### 6.4 도메인 관리

- [DOM-1] 도메인 조회 — `domain.read`(owned) 또는 Grant `domain.read` 또는 `domain.read.all`
- [DOM-2] 도메인 등록 — `domain.create` | 등록 시 `verify_token` 발급, `UNVERIFIED` 상태
- [DOM-3] 소유권 검증 — `domain.verify`(소유자 포함) | DNS TXT 레코드 조회로 검증, 성공 시 `VERIFIED`
- [DOM-4] 도메인 설정 수정 — `domain.update`(소유자) 또는 Grant `domain.update`
- [DOM-5] 도메인 운영 위임 — 소유자가 Grant(`domain.update`, `domain.verify`) 생성 | 파일 공유와 동일 메커니즘 재사용
- [DOM-6] 소유자 이전 — `domain.transfer` | 소유자 본인 발의 + 수령자 수락의 2단계. 이전 완료 시 기존 Grant 전체 삭제
- [DOM-7] 도메인 삭제 — `domain.delete`(owned) 또는 `domain.delete.all`

### 6.5 관리자 콘솔

- [ADM-1] 역할 목록/상세 — `admin.role.read`
- [ADM-2] 역할 생성/수정/삭제 — `admin.role.manage` | 역할의 권한 파워 통제는 ADM-3(보유 Permission만 매핑 가능)이 담당. `is_system` 역할은 삭제·코드 변경 불가
- [ADM-3] 역할-권한 매핑 편집 — `admin.role.manage` | 자신이 보유하지 않은 Permission은 타 역할에 부여 불가(§10.1)
- [ADM-4] 감사 로그 조회 — `admin.audit.read` | 행위자·대상·기간·행위 유형 필터
- [ADM-5] 권한 시뮬레이터 — `admin.role.read` | "사용자 X가 리소스 Y에 Z를 할 수 있는가"를 평가 단계별 근거와 함께 표시 (운영 중 권한 문의 대응 도구)

---

## 7. API 설계

### 7.1 공통 규약

- Base URL: `/api/v1`
- 인증: `Authorization: Bearer {access_token}`
- 권한 부족 응답: 인증 실패 `401`, 권한 부족 `403`. 단, **리소스 존재 여부가 권한에 따라 숨겨져야 하는 조회형 API는 `404`로 응답**한다(존재 노출 방지 — §10.2)
- 에러 형식: `{ "error": { "code": "FORBIDDEN", "message": "...", "traceId": "..." } }`

### 7.2 엔드포인트 목록 (발췌)

| 메서드 | 경로 | 요구 Permission | 비고 |
|---|---|---|---|
| POST | `/auth/signup` | - | AUTH-1 |
| POST | `/auth/login` | - | AUTH-2 |
| POST | `/auth/refresh` | - | AUTH-3 |
| GET | `/me` | - (인증만) | 프로필 + 권한 스냅샷(§8.3) |
| GET | `/members` | `member.read` | 페이지네이션 |
| PATCH | `/members/:id` | `member.update` (+우위) | |
| POST | `/members/:id/ban` | `member.ban` (+우위) | |
| POST | `/members/:id/roles` | `member.role.assign` (+우위, 부분집합) | |
| DELETE | `/members/:id/roles/:roleId` | `member.role.assign` (+우위, 부분집합) | |
| POST | `/files/upload-url` | `file.upload` | 서명 URL 발급 |
| GET | `/files` | `file.read` | 내 파일 + 공유받은 파일 |
| GET | `/files/:id/download-url` | `can(file.read, 해당 파일)` | 평가기 전체 단계 적용 |
| POST | `/files/:id/shares` | `can(file.share, 해당 파일)` | FILE-4 |
| DELETE | `/files/:id/shares/:grantId` | 소유자 또는 공유 생성자 | FILE-5 |
| DELETE | `/files/:id` | `can(file.delete, 해당 파일)` | |
| GET | `/domains` | `domain.read` | 소유+위임분 |
| POST | `/domains` | `domain.create` | |
| POST | `/domains/:id/verify` | `can(domain.verify, 해당 도메인)` | |
| POST | `/domains/:id/transfer` | `can(domain.transfer, 해당 도메인)` | 2단계 |
| GET | `/admin/roles` | `admin.role.read` | |
| POST | `/admin/roles` | `admin.role.manage` | |
| PUT | `/admin/roles/:id/permissions` | `admin.role.manage` | 전체 치환 방식 |
| GET | `/admin/audit-logs` | `admin.audit.read` | |
| POST | `/admin/simulate` | `admin.role.read` | ADM-5 |

### 7.3 권한 선언 방식 (백엔드)

NestJS 데코레이터로 엔드포인트에 권한을 선언한다. 선언이 없는 엔드포인트는 전역 Guard가 기동 시점에 검출하여 **서버 기동을 실패시킨다**(INV-5의 구현 장치). 공개 엔드포인트는 `@Public()`을 명시해야 한다.

```typescript
@RequirePermission('file.delete', { resource: 'file', param: 'id' })
@Delete('files/:id')
deleteFile(@Param('id') id: string) { ... }
```

**관계형 2차 인가 패턴**: "소유자 또는 공유 생성자"(FILE-5), "발의자+수락자 2단계"(DOM-6)처럼 단일 Permission 코드로 환원되지 않는 조건은, (1) 게이트 Permission을 `@RequirePermission`으로 선언하고 (2) 핸들러 내부에서 표준 정책 헬퍼(`PolicyService`)로 관계 조건을 검사하는 2단 구성을 표준으로 한다. 관계 조건을 핸들러에 임의 구현하는 것을 금지하고 반드시 `PolicyService`에 명명된 정책 함수(예: `canRevokeShare(subject, grant)`)로 두어, 감사와 권한 시뮬레이터(ADM-5)가 동일 로직을 재사용할 수 있게 한다. 각 정책 함수의 규칙은 기능 명세(§6)의 해당 항목을 유일한 출처로 삼는다.

### 7.4 권한 검사 계층

```
요청 → [1] AuthGuard: 토큰 검증, subject 확정
     → [2] PermissionGuard: @RequirePermission 선언 수집
     → [3] AuthorizationService.can(): §4.7 평가기 실행
     → [4] (관리 행위) DominanceGuard: §4.6 우위·부분집합 검사
     → [5] 핸들러 실행 — 권한 변경 행위는 변경과 감사 기록을
           동일 DB 트랜잭션으로 커밋 (INV-6의 구현 지점)
     → [6] AuditInterceptor: 조회·비변경 행위의 사후 접근 로그
```

INV-6(감사 실패 시 롤백)은 [6]의 인터셉터로는 구현할 수 없다 — 인터셉터 시점에는 핸들러 트랜잭션이 이미 커밋되어 있다. 따라서 **권한 변경(역할 부여/회수, 매핑 편집, Grant 생성/회수, 정지/삭제)의 감사 기록은 반드시 서비스 계층 트랜잭션 내부에서 수행**하고, 인터셉터는 롤백이 불필요한 접근 로그 전용으로 한정한다.

---

## 8. 인증 · 세션 · 권한 캐싱

### 8.1 토큰 구조

- **Access Token**: JWT, 수명 10분. 페이로드는 `sub`(user id), `tenant`, `pv`(perm_version), `exp`만 포함한다. **역할·권한 목록을 JWT에 넣지 않는다** — 넣는 순간 권한 회수가 토큰 만료까지 지연되는 구조적 결함이 생긴다.
- **Refresh Token**: 불투명 랜덤 문자열, 수명 14일, DB에 해시만 저장. 사용 시마다 회전(rotation)하며, 폐기된 토큰이 재사용되면 해당 family 전체를 즉시 폐기한다(탈취 탐지).

### 8.2 권한 확정 시점

권한은 **매 요청 시점에 서버가 확정**한다. JWT는 신원(identity)만 증명한다. 요청 처리 시 Redis의 권한 스냅샷(아래)을 조회하고, 없으면 DB에서 재구성한다.

### 8.3 권한 스냅샷 캐시와 무효화

```
키:   perm:{user_id}
값:   { pv, status, roles: [code...],
        permissions: [{code, scope}...] }
TTL:  300초
```

우위 검사(§4.6)는 이 스냅샷의 `permissions` 집합 비교로 수행한다 — 관리 행위 시 대상자의 스냅샷(또는 DB 재구성분)과 대조하므로 추가 저장 항목이 필요 없다.

- **권위 소스는 DB의 `users.perm_version`이다.** 캐시는 참조 사본이며, pv 비교의 기준은 항상 DB 값(또는 DB에서 방금 재구성한 스냅샷)이다.
- 무효화 순서: 권한 변경 트랜잭션에서 (1) `perm_version` 1 증가 커밋 → (2) Redis 키 삭제. 이 순서를 강제하여, 삭제 직후 이전 값이 재기록(stale write)되더라도 pv 불일치로 감지되게 한다. 스냅샷 재기록 시에는 재구성 시점에 읽은 pv를 값에 포함하고, 요청 처리 시 JWT의 `pv`·스냅샷의 `pv`·(불일치 의심 시) DB의 `perm_version` 순으로 대조한다. JWT `pv`가 DB와 다르면 Access Token을 거부하고 재발급을 요구한다. 이로써 **권한 회수가 최대 수 초 내에 전파**된다.
- 역할-권한 매핑 변경(역할 자체의 권한 변경)은 해당 역할 보유자 전원의 `perm_version`을 배치 증가시키고 스냅샷 키를 삭제한다. 키 삭제만으로는 Redis 명령 유실 시 최대 TTL 동안 구권한이 유지되는 구멍이 생기므로, **pv 증가를 반드시 동반**하여 백스톱을 확보한다(`idx_user_roles_role` 인덱스로 보유자 조회).
- 스냅샷에 `status`를 포함하여 평가기 0단계(§4.7)가 캐시 적중 시에도 상태 검사를 수행할 수 있게 한다. 정지·삭제는 pv 증가를 동반하므로 상태 변경도 수 초 내 반영된다.
- 리소스 Grant는 캐시하지 않고 매번 DB 조회한다. `idx_grants_lookup` 인덱스 단일 조회이므로 병목이 아니며, 공유 회수의 즉시성이 보장된다.

### 8.4 프론트엔드 권한 반영

`GET /me` 응답에 권한 스냅샷을 포함하고, 프론트는 이를 기준으로 메뉴·버튼 표시를 분기한다. 표시 분기는 UX 목적이며(§3), 서버 403/404 응답을 항상 처리한다.

---

## 9. 확장 지점 설계

본 장이 "가장 확장적인 방식"의 실체다. 각 확장은 **기존 스키마 변경 없이**(INV-7) 데이터 추가 또는 예약 필드 활성화로 달성된다.

### 9.1 신규 기능 모듈 편입 절차 (표준 확장 경로)

예: "게시판" 모듈 추가 시.

1. Permission 시드에 행 추가: `board.post.read`, `board.post.create`, `board.post.delete`, `board.post.delete.all` … (`module='board'`)
2. 역할-권한 매핑 추가: `MEMBER`에 read/create, `OPERATOR`에 delete.all 등 (관리 콘솔 또는 시드)
3. 게시판 API에 `@RequirePermission('board.post.create')` 선언
4. 게시글 단위 예외가 필요해지면 `resource_grants`에 `resource_type='board.post'`로 저장 — 테이블 추가 불필요

권한 시스템 쪽 코드 변경량: **0줄.** 이것이 본 설계의 핵심 검수 기준이다.

### 9.2 멀티테넌트 전환

예약된 확장 지점: 모든 핵심 테이블(매핑 테이블 `user_roles`·`role_permissions` 포함)의 `tenant_id`, `UNIQUE(tenant_id, ...)` 제약, JWT의 `tenant` 클레임.

전환 절차: (1) 테넌트 생성/초대 기능 구현 → (2) 요청 컨텍스트에 테넌트 확정 미들웨어 추가 → (3) Prisma 미들웨어(또는 PostgreSQL RLS)로 모든 쿼리에 `tenant_id` 필터 강제 — 매핑 테이블도 자체 `tenant_id`를 가지므로 RLS를 직접 적용할 수 있다 → (4) 역할을 테넌트별로 복제 생성(roles가 이미 `tenant_id`를 가지므로 스키마 변경 없음). 기존 데이터는 전부 기본 테넌트 소속이므로 마이그레이션이 불필요하다.

전환 시 함께 확정해야 하는 사항(전환 절차의 일부로 명시):

- **교차 테넌트 무결성**: 역할 부여·Grant 생성 시 user·role·resource의 `tenant_id` 일치를 서비스 계층에서 검증하고, 매핑 테이블에는 트리거로 이중 강제한다. 논리 참조인 `resource_grants`는 이 검증이 유일한 방어선이다(§5.3).
- **로그인 테넌트 식별**: `UNIQUE(tenant_id, email)`상 동일 이메일이 복수 테넌트에 존재할 수 있으므로, 로그인 시 테넌트 식별 수단(테넌트별 서브도메인 또는 명시 파라미터)을 도입한다. Phase 1의 단일 테넌트에서는 불필요.
- **테넌트 관리자 부트스트랩**: 신규 테넌트 생성 시 해당 테넌트의 최상위 역할(`TENANT_ADMIN`)과 최초 관리자 계정을 시스템이 자동 시딩한다. `TENANT_ADMIN`의 Permission 집합에는 시스템 전역 권한(`system.settings.manage` 등)을 포함하지 않으므로, 부분집합 검사(§4.6-2)에 의해 테넌트 관리자는 전역 `SUPER_ADMIN` 역할을 부여할 수 없다 — 별도 규칙 없이 격리가 유지된다.

### 9.3 ABAC(속성 조건) 확장

`resource_grants.conditions`(JSONB) 예약 필드를 활성화한다. 평가기 4단계에서 Grant 매칭 후 조건 평가를 추가한다.

```json
{ "ip_cidr": ["10.0.0.0/8"], "time_range": {"from": "09:00", "to": "18:00"}, "max_downloads": 10 }
```

조건 어휘는 화이트리스트로 관리하며, 임의 표현식 평가(eval)는 금지한다. Phase 1에서는 미구현, 필드만 예약.

### 9.4 주체(Subject) 확장 — API Key, 그룹

`resource_grants.subject_type` 예약 필드를 활성화한다.

- **API Key**: `api_keys` 테이블 신설(키 → 보유 Permission 집합) 후, 평가기의 subject 해석부에 분기 추가. 외부 연동·자동화 시나리오 대응.
- **그룹(부서) 단위 공유**: `groups`, `group_members` 테이블 신설, `subject_type='GROUP'` Grant 지원. 평가기 4단계에서 "사용자의 소속 그룹" 조회가 추가된다. 이것이 ReBAC 방향의 점진적 확장 경로이며, 전면 ReBAC 재설계 없이 대부분의 공유 요구를 흡수한다.

### 9.5 승인 워크플로 확장

`user_roles.expires_at`, `resource_grants.expires_at`이 이미 임시 부여를 지원한다. 여기에 `permission_requests` 테이블(요청 → 승인 → 자동 Grant 생성)을 추가하면 "권한 신청/결재" 기능이 된다. 승인 행위 자체도 `admin.permission.approve` Permission으로 통제한다 — 권한 시스템이 자기 자신을 관리하는 구조.

**쿼럼 승인 구조 (`SUPER_ADMIN` 비상 회수 — 예약)**: 본 워크플로의 선행 구현으로, `SUPER_ADMIN`을 대상으로 하는 관리 조치(정지·역할 회수)에 한해 우위 검사(§4.6-1)의 동집합 거부에 대한 **의도적·명시적 예외 경로**를 둔다. 발의자 외 타 활성 `SUPER_ADMIN` 과반수(최소 2인) 승인이 모이면 조치가 실행되며, 발의·승인·실행 전 과정을 감사 로그에 별도 심각도로 기록한다. 단독 `SUPER_ADMIN`으로는 쿼럼이 성립하지 않으므로, 이 구조 도입 후에도 break-glass 절차(§10.1)는 최후 수단으로 유지한다. 발주자 결정(2026-08-07)에 따라 Phase 3 확장으로 예약하며, Phase 1은 break-glass 절차만으로 대응한다.

### 9.6 확장 시나리오 검증표

| 미래 요구 | 대응 방법 | 스키마 변경 |
|---|---|---|
| "결제 기능 추가" | §9.1 절차 | 없음 (permissions 행 추가) |
| "특정 파일을 외부 협력사에 3일만 공유" | Grant + `expires_at` | 없음 |
| "야간에는 다운로드 금지" | §9.3 conditions | 없음 (예약 필드 활성화) |
| "부서 단위 폴더 공유" | §9.4 그룹 Grant | groups 테이블 신설 (기존 테이블 무변경) |
| "B2B 고객사별 공간 분리" | §9.2 절차 | 없음 (예약 컬럼 활성화) |
| "읽기 전용 감사자 계정" | 역할 신설 (`admin.audit.read`만 보유) | 없음 |
| "특정 회원의 특정 도메인 접근만 차단" | Grant `effect=DENY` | 없음 |

---

## 10. 보안 설계

### 10.1 권한 상승(Privilege Escalation) 방지 규칙

권한 시스템 자체가 공격 표면이다. 아래 규칙으로 알려진 상승 경로를 차단한다.

| 공격 경로 | 차단 규칙 |
|---|---|
| 자신에게 높은 역할 부여 | 본인 대상 역할 변경 전면 금지(§4.6-1). 타인 대상은 부분집합 검사(§4.6-2) 적용 |
| 강한 권한을 담은 역할을 만들어 취득 | 역할-권한 매핑 편집 시 자신이 보유한 Permission만 부여 가능 (ADM-3) |
| 강한 권한이 담긴 기존 역할을 공모 계정에 부여하여 간접 상승 | 역할 부여 시 부분집합 검사(§4.6-2): 부여자가 보유하지 않은 Permission이 담긴 역할은 부여 불가 |
| 동급 관리자 계정 정지 후 역할 탈취 | 우위 검사(§4.6-1)의 동집합·비교불가 거부 |
| 공유받은 파일 재공유로 전파 | Grant 부여 가능 화이트리스트에서 `file.share` 제외 (§4.4, FILE-4) |
| 최고관리자 소멸로 시스템 잠금 | 불변식 "활성(`status=ACTIVE`, 역할 미만료) `SUPER_ADMIN` ≥ 1"을 회수·정지·삭제 **모든 경로**에서 사전 검사. 검사와 변경은 `SELECT ... FOR UPDATE`(또는 SERIALIZABLE)로 원자화하여 동시 강등 경쟁 조건을 차단. `SUPER_ADMIN`에는 `expires_at` 부여 금지(§4.5)로 만료 소멸 경로도 제거 |
| `SUPER_ADMIN` 계정 탈취 (동집합 거부의 파생으로 시스템 내 정상 경로로는 회수·정지 불가) | **Phase 1**: 운영 런북의 break-glass 절차 — 2인 입회, 평시 비활성 전용 DB 계정, 실행 전·후 전량 감사 기록, 실행 후 전 세션 강제 무효화(전 사용자 `perm_version` 증가). 절차는 운영 런북(§13.3)에 문서화하고 저장소에서 관리. **Phase 3**: 쿼럼 승인 구조(§9.5)로 시스템 내 경로 제공 |
| 정지된 계정이 리프레시 토큰으로 세션 유지 | 정지·삭제 시 리프레시 토큰 패밀리 전체 폐기(MEM-4/6) + 갱신 시 상태 재검증(AUTH-3) |
| 토큰 탈취 후 권한 회수 회피 | JWT에 권한 미포함 + `perm_version` 불일치 거부(§8.1, §8.3) |

### 10.2 정보 노출 방지

- 권한 없는 리소스 조회는 403이 아닌 404로 응답한다(리소스 존재 자체를 숨김). 목록 API는 권한 범위 내 행만 반환한다.
- 파일 `storage_key`, 사용자 `password_hash` 등 내부 필드는 API 응답 직렬화 계층에서 화이트리스트 방식으로만 노출한다.
- 에러 메시지에 "권한이 없습니다" 이상의 내부 판단 근거(어느 단계에서 거부됐는지)를 노출하지 않는다. 판단 근거는 관리자용 시뮬레이터(ADM-5)와 서버 로그에서만 제공한다.

### 10.3 권한 시스템 자체의 보호

- `permissions` 테이블은 코드 배포에 포함된 시드 마이그레이션으로만 변경한다. 관리 콘솔은 역할과 매핑만 편집할 수 있다. (Permission을 UI에서 만들 수 있으면 오타·중복 코드가 축적되어 평가 무결성이 무너진다.)
- `is_system=true` 역할(`MEMBER`, `SUPER_ADMIN`)은 삭제·코드 변경을 금지한다.
- 역할 삭제 시 보유자가 존재하면 거부한다(선 회수, 후 삭제).
- 감사 로그는 append-only로 운영하며 UPDATE/DELETE 권한을 애플리케이션 DB 계정에서 제거한다.

### 10.4 일반 보안 요건

- 비밀번호: argon2id, 최소 10자. 유출 비밀번호 목록(HIBP k-anonymity) 대조.
- 관리 역할(`OPERATOR` 이상) 계정은 2FA(TOTP)를 강제한다.
- 전 구간 TLS, 쿠키 사용 시 `HttpOnly; Secure; SameSite=Lax`.
- 업로드 파일: 확장자·MIME 이중 검증, 크기 상한(기본 100MB), 실행 파일 차단 정책, 다운로드 시 `Content-Disposition: attachment` 강제.
- 요청 속도 제한: 인증 API 5회/분/IP, 일반 API 사용자별 정책.

---

## 11. 비기능 요구사항

| 항목 | 목표 | 설계 근거 |
|---|---|---|
| 권한 평가 지연 | p95 < 5ms (캐시 적중 시), < 30ms (미적중) | 스냅샷 캐시(§8.3) + Grant 단일 인덱스 조회 |
| 권한 회수 전파 | 10초 이내 | perm_version 즉시 불일치 |
| 동시 사용자 | 초기 1천, 확장 시 수평 스케일 | 백엔드 무상태(세션은 Redis/DB) |
| 감사 로그 보존 | 3년 (파티션 단위 아카이브) | 월 파티셔닝 |
| 가용성 | 99.9% | 권한 캐시 미적중 시에도 DB 폴백으로 동작 지속 |
| 테스트 | 평가기(§4.7)는 표 기반(table-driven) 단위 테스트로 §4.8 전 사례 + 경계 사례를 커버. 권한 매트릭스(역할×API) 통합 테스트와 §10.1 공격 시나리오 테스트를 CI 필수 게이트로 지정 | |

---

## 12. 구현 로드맵

### Phase 1 — 기반 (4~6주)

- **저장소·CI 기반 구축을 최우선 착수**: §16.2 모노레포 구조, 브랜치 보호, CI 게이트 G-1~G-5(§14.2) — 첫 기능 코드보다 먼저
- 인증(AUTH-1~4), users/roles/permissions/user_roles/role_permissions 스키마, 시드
- 권한 평가기 + Guard 체계(§7.3~7.4) + 기동 시 미선언 엔드포인트 차단
- 회원 관리(MEM-1~6), 우위·부분집합 검사(§4.6)
- 감사 로그 기록 체계
- 관리자 콘솔: 역할 조회·매핑 편집(ADM-1~3)
- **완료 기준**: 권한 매트릭스 통합 테스트 통과, §10.1 공격 시나리오 전건 차단 확인

### Phase 2 — 리소스 권한 (3~4주)

- 파일(FILE-1~7): 업로드/다운로드/공유 — resource_grants 실전 투입
- 도메인(DOM-1~7): 등록/검증/위임/이전
- 감사 로그 조회(ADM-4), 권한 시뮬레이터(ADM-5)
- 런타임 불변식 순찰 워커 + 3단계 대응·보고(§14.3~14.4)
- **완료 기준**: 공유·회수 즉시성 검증, 고아 Grant 정리 배치 동작, 불변식 RI-1~RI-7 순찰 가동

### Phase 3 — 선택 확장 (수요 발생 시)

- §9.3 ABAC 조건 / §9.4 API Key·그룹 / §9.5 승인 워크플로 / §9.2 멀티테넌트 중 사업 우선순위에 따라 선택

---

## 13. 부록

### 13.1 시드 데이터 체크리스트

1. 기본 테넌트 1행 (고정 UUID)
2. Permission 26종 + scope 지정 (§4.4)
3. 역할 5종 + display_order + 매핑 (§4.5)
4. 최초 `SUPER_ADMIN` 계정: 환경 변수 기반 생성 스크립트(비밀번호 하드코딩 금지), 최초 로그인 시 비밀번호 변경 강제

### 13.2 구현 착수 전 결정 필요 항목 (Open Questions)

| 항목 | 기본안 | 결정 필요 사유 |
|---|---|---|
| 이메일 발송 수단 | 트랜잭션 메일 서비스(예: SES) | 비용·발신 도메인 |
| 파일 저장 위치 | AWS S3 | 국내 규제·비용에 따라 변동 가능 |
| 도메인 검증 방식 | DNS TXT | HTML 파일 업로드 방식 병행 여부 |
| 탈퇴 회원 데이터 보존 기간 | 30일 후 개인정보 파기(법정 의무 항목 제외) | 개인정보처리방침과 연동 |

### 13.3 관련 문서 (추후 작성)

- API 상세 명세 (OpenAPI 3.1)
- 화면 설계서
- 운영 런북 (권한 사고 대응 절차 + `SUPER_ADMIN` break-glass 비상 회수 절차(§10.1) 포함 — break-glass 절차는 Phase 1 산출물로 작업지시서 WP-6에 편입)

---

## 14. 권한 거버넌스 자동화 (감시 · 차단 · 보고)

### 14.1 목적과 전제

기능 모듈이 §9.1 절차로 계속 누적되고 기존 코드가 수정·보완되는 과정에서, 의도하지 않은 권한 누수(leak)와 우회 경로(backdoor)가 발생하는 것을 **기계적으로 탐지·차단·보고**하는 상시 체계를 정의한다.

이 체계가 성립하는 전제는 본 설계의 두 가지 성질이다: (a) 모든 권한 판정이 단일 평가기(§4.7)를 통과한다, (b) 권한의 현재 상태가 전부 데이터(테이블)로 존재한다. 따라서 감시 대상이 명확하며, 신규 기능이 얹힐 때마다 감시 범위가 데이터에서 자동 파생된다 — 거버넌스 체계 자체는 기능 추가 시 수정이 필요 없다(INV-7과 동일 원리).

### 14.2 1겹 — 배포 전 검문 (CI 게이트)

코드가 배포되기 전, CI 파이프라인에서 아래 검사를 전부 통과해야 병합·배포가 가능하다.

| 게이트 | 검사 내용 | 실패 시 |
|---|---|---|
| G-1. 권한 매트릭스 스냅샷 | "역할 × API → 허용/거부" 전체 표를 골든 파일(`governance/matrix.yaml`)로 박제. 통합 테스트가 실제 API에 대해 표를 재생성하여 골든 파일과 비교 | 1칸이라도 다르면 빌드 실패. 의도한 변경이면 골든 파일을 갱신하는 커밋 + 리뷰 승인 필수 |
| G-2. 금지 패턴 정적 검사 | INV-1 위반(`role ===`, `display_order` 비교), 평가기·`PolicyService`를 우회하는 직접 쿼리, 권한 테이블 직접 조작 코드를 정적 분석으로 검출 | 빌드 실패 |
| G-3. 공격 시나리오 회귀 | §10.1 차단표의 전 시나리오를 테스트 코드로 유지. 신규 기능이 기존 공격 경로를 재개방하지 않는지 매 빌드 재검증 | 빌드 실패 |
| G-4. 시드 정합성 | 신규 Permission의 명명 규약(§4.2)·scope·module 지정 여부, 와일드카드 전개 결과, Grant 화이트리스트(§4.4)와의 정합 검사 | 빌드 실패 |
| G-5. 미선언 엔드포인트 | `@RequirePermission`/`@Public` 미선언 API 검출 (§7.3의 기동 차단을 CI에서 선행 실행) | 빌드 실패 |

권한 누수의 다수는 "의도하지 않은 매트릭스 변화"이므로 G-1이 핵심 게이트다. 골든 파일의 diff는 PR 리뷰 화면에 그대로 노출되어, **권한 변화가 코드 리뷰의 1급 검토 대상**이 된다.

### 14.3 2겹 — 운영 중 불변식 순찰 (런타임 모니터)

배포 이후, 스케줄 워커가 주기(기본 10분)마다 DB에 대해 불변식을 검사한다. 불변식 정의는 저장소에 버전 관리되는 선언적 목록으로 관리한다(§16).

| ID | 불변식 | 위반 의미 |
|---|---|---|
| RI-1 | 활성 `SUPER_ADMIN` ≥ 1 | 시스템 잠금 위험 (§10.1) |
| RI-2 | `granted_by = 대상 user_id`인 user_roles 부재 | 자기 부여 백도어 |
| RI-3 | 모든 resource_grants가 리소스 타입별 화이트리스트(§4.4) 내부 | 우회 Grant 주입 |
| RI-4 | 고아 Grant(삭제된 리소스·사용자 참조) 부재 | 정리 누락 (§5.3) |
| RI-5 | user·role·resource의 tenant 일치 | 교차 테넌트 누수 (§9.2) |
| RI-6 | `is_system` 역할의 코드·존재 불변 | 시스템 역할 변조 |
| RI-7 | 감사 로그 시퀀스 연속성(누락 구간 부재) | 로그 삭제·우회 시도 |

추가로 감사 로그 스트림에 대한 규칙 기반 이상 탐지를 수행한다: 비업무 시간대의 대량 역할 부여, 단일 계정의 DENY 급증(권한 탐색 정황), 휴면 관리 권한의 최초 사용, 단시간 대량 Grant 생성 등.

### 14.4 3겹 — 자물쇠(대응)와 보고

자동 차단은 오탐 시 정상 운영을 잠그는 역작용이 있으므로, **위반의 확실성에 따라 3단계로 차등 대응**한다.

| 단계 | 조건 | 대응 |
|---|---|---|
| L-1 즉시 자동 조치 | 불변식 위반 중 기계적으로 확실한 것 (RI-3 화이트리스트 밖 Grant, RI-4 고아 Grant) | 해당 행 자동 회수(회수 자체도 감사 로그 기록) + 실시간 알림 |
| L-2 동결 후 승인 대기 | 이상 탐지 정황 (자기 부여 의심, 비정상 패턴) | 관련 계정의 **권한 변경 기능만** 동결(서비스 이용은 유지), `SUPER_ADMIN` 승인 시 해제 |
| L-3 보고 | 경미·정보성 (매트릭스 변경 이력, 휴면 권한 통계) | 주간 권한 드리프트 리포트로 취합 |

보고 채널: L-1·L-2는 실시간 알림(운영 채널 webhook + 이메일), L-3은 주간 리포트. 모든 거버넌스 이벤트는 자체적으로 감사 로그에 기록된다 — 감시자도 감사 대상이다.

### 14.5 한계 명시 (정직성 조항)

본 체계가 탐지하지 못하는 영역을 명시한다. 이 항목들은 사람의 코드 리뷰와 정기 침투 테스트가 담당한다.

1. **정책 함수 내부의 논리 버그**: `PolicyService`의 관계 검사 코드가 미묘하게 잘못된 경우, 매트릭스는 정상으로 보인다. 테스트 케이스가 해당 경로를 덮을 때만 탐지된다.
2. **평가기를 완전히 우회하는 신규 코드**: G-2가 알려진 패턴은 잡지만, 정적 분석은 완전하지 않다.
3. **정당한 권한 보유자의 악의적 사용**: 이상 탐지로 정황만 포착 가능하다.

---

## 15. 구현 언어 · 도구 선정

### 15.1 원칙

거버넌스 로봇(§14)을 포함한 전 구성요소는 **백엔드와 동일 언어(TypeScript)로 구현**한다. 근거: 감시 로직이 실제 권한 로직(평가기·`PolicyService`)을 **그대로 import하여 재사용**해야, "감시용 로직과 실제 로직의 이중 구현 → 둘의 불일치가 곧 탐지 불가능한 누수"라는 근본 문제를 차단할 수 있다. 별도 언어(예: Python 감시 스크립트)의 도입은 이 원칙 위반으로 금지한다. 예외는 언어 중립 도구(정적 분석기, DB)뿐이다.

### 15.2 구성요소별 선정

| 구성요소 | 선정 | 근거 |
|---|---|---|
| 애플리케이션 | TypeScript / Next.js 15 + NestJS 11 (§3 유지) | 단일 언어로 프론트–백–거버넌스 관통 |
| 매트릭스 테스트 (G-1) | Jest + Supertest, 골든 파일은 YAML | 표 기반 테스트·diff 가독성 |
| 금지 패턴 검사 (G-2) | ESLint 커스텀 룰(1차) + Semgrep(2차) | ESLint는 TS 문법 수준, Semgrep은 의미 패턴(우회 쿼리) 검출. 룰 파일은 저장소에 버전 관리 |
| 공격 회귀 (G-3) | Jest 통합 테스트 스위트 `attack-scenarios.spec.ts` | §10.1과 1:1 대응, 시나리오 ID를 테스트명에 명시 |
| CI 실행 | GitHub Actions | PR 필수 게이트 지정(브랜치 보호), 골든 파일 diff 노출 |
| 런타임 순찰 (§14.3) | NestJS 워커(`@nestjs/schedule`) + 불변식은 SQL 파일로 선언 관리 | 평가기 코드 재사용 + 불변식의 버전 관리 용이 |
| 이상 탐지 | 초기: 규칙 기반 SQL(파티션 테이블 직접 질의). 로그량 증가 시 OpenSearch 파이프라인으로 승격 | 초기부터 ML·전용 SIEM 도입은 과잉. 승격 기준: 감사 로그 월 1천만 행 초과 |
| 알림 | 운영 채널 webhook(Slack 등) + 이메일(SES) | L-1/L-2 실시간, L-3 주간 |
| 침투 테스트 보조 | OWASP ZAP 자동 스캔(분기 1회) + 수동 침투(연 1회 권장) | §14.5 한계 보완 |

---

## 16. 버전 관리 전략 (설계 단계부터 프로그램적 관리)

### 16.1 원칙 — "설계 산출물도 코드다"

본 기획서를 포함한 모든 설계 산출물과 권한 정의를 **초기 설계 단계인 지금부터** Git 단일 저장소(모노레포)에서 관리한다. 문서·권한 시드·매트릭스·불변식·린트 룰이 코드와 같은 저장소에 있어야, 코드 변경과 설계 변경이 **하나의 PR에서 함께 리뷰**되고 서로 어긋난 채 배포되는 것을 구조적으로 막는다.

### 16.2 저장소 구조

```
stonex/
├── docs/
│   ├── permission-system-spec.md   ← 본 문서 (개정 = PR)
│   └── adr/                        ← 아키텍처 결정 기록 (ADR, 결정 1건 = 파일 1개)
├── apps/
│   ├── web/                        ← Next.js
│   └── api/                        ← NestJS (평가기·PolicyService 포함)
├── db/
│   ├── migrations/                 ← Prisma 마이그레이션 (forward-only)
│   └── seeds/permissions.ts        ← Permission·역할 정의 (유일한 출처)
└── governance/
    ├── matrix.yaml                 ← 권한 매트릭스 골든 파일 (G-1)
    ├── invariants/*.sql            ← 런타임 불변식 (§14.3)
    ├── eslint-rules/               ← 금지 패턴 룰 (G-2)
    └── semgrep/*.yaml
```

### 16.3 버전 관리 규칙

1. **권한 모델의 변경 = 마이그레이션**: permissions·roles·매핑의 모든 변경은 forward-only 마이그레이션 파일로만 수행한다. 운영 DB 직접 수정 금지. 마이그레이션 이력이 곧 권한 모델의 버전 이력이 된다.
2. **문서 개정 = PR**: 본 문서의 개정은 PR로만 수행하며, §17 변경 이력에 버전·사유를 기록한다. 설계 결정의 근거는 ADR로 분리 기록한다(예: "ADR-0002: rank 제거와 집합 우위 대체"). 리뷰 승인 없는 `main` 병합은 브랜치 보호로 차단한다 — 이는 "땜질 시 사전 승인" 원칙의 기술적 강제 장치이기도 하다.
3. **커밋·릴리스 규약**: Conventional Commits(`feat:`, `fix:`, `perm:` 커스텀 타입 — 권한 변경 커밋은 `perm:` 필수)를 적용하고, 체인지로그는 도구로 자동 생성한다. `perm:` 커밋은 G-1 골든 파일 변경을 동반해야 하며, 동반하지 않으면 CI가 실패한다.
4. **시맨틱 버저닝**: 애플리케이션 릴리스는 SemVer 태그로 관리한다. 권한 모델 관점의 기준 — 평가기 의미론·테이블 구조 변경 = major, Permission·역할 추가 = minor, 매핑·문구 수정 = patch. 배포 태그와 DB 마이그레이션 버전을 릴리스 노트에서 연동 기록한다.
5. **재현 가능성**: 임의 시점의 태그를 체크아웃하면 그 시점의 문서·권한 정의·매트릭스·코드가 전부 일치 상태로 복원된다. 권한 사고 조사 시 "그 시점에 규칙이 무엇이었나"를 저장소가 증명한다.

---

## 17. 변경 이력

### v1.4 (2026-08-07) — `SUPER_ADMIN` 비상 회수 경로 확정

작업지시서 v1 레드팀 검토(`phase1-work-order-review-v1.md` RT-1)에서, 우위 검사의 동집합 거부(§4.6-1) 파생으로 탈취된 `SUPER_ADMIN`을 시스템 내 어떤 정상 경로로도 무력화할 수 없는 공백이 확인되었다. 발주자 결정(단계적 도입)을 반영한다.

1. **§10.1 차단표에 `SUPER_ADMIN` 계정 탈취 행 추가**: Phase 1은 운영 런북의 break-glass 절차(2인 입회, 전용 DB 계정, 전량 감사, 사후 전 세션 무효화), Phase 3은 쿼럼 승인 구조로 대응.
2. **§9.5에 쿼럼 승인 구조 예약**: `SUPER_ADMIN` 대상 조치에 한해 동집합 거부의 명시적 예외 경로 — 타 활성 `SUPER_ADMIN` 과반수(최소 2인) 승인으로 실행. Phase 3 확장.
3. **§4.6-1에 파생 결과 명시**: `SUPER_ADMIN` 상호 관리 불가가 의도된 동작임과 비상 회수 경로의 소재를 본문에 기재.
4. **§13.3 운영 런북 항목 구체화**: break-glass 절차를 Phase 1 산출물(작업지시서 WP-6)로 명시.

### v1.3 (2026-08-07) — 거버넌스 자동화 · 구현 도구 · 버전 관리 장 추가

발주자 요구 3건 반영.

1. **§14 권한 거버넌스 자동화 신설**: 기능 누적·코드 수정 과정의 권한 누수/백도어를 감시하는 3겹 체계(CI 게이트 5종 → 런타임 불변식 순찰 7종+이상 탐지 → 확실성 차등 3단계 대응·보고). 탐지 불가능 영역을 §14.5에 정직성 조항으로 명시.
2. **§15 구현 언어·도구 선정 신설**: 거버넌스 로직은 백엔드와 동일한 TypeScript로 구현하여 평가기 코드를 직접 재사용(이중 구현 금지 원칙). ESLint+Semgrep, Jest 골든 파일, GitHub Actions, NestJS 워커 등 구성요소별 선정과 근거.
3. **§16 버전 관리 전략 신설**: "설계 산출물도 코드다" — 문서·권한 시드·매트릭스·불변식을 초기 설계 단계부터 Git 모노레포에서 관리. 권한 변경은 forward-only 마이그레이션 + `perm:` 커밋 규약 + 골든 파일 동반 강제. 문서 개정은 PR·ADR로만.
4. 로드맵(§12)에 거버넌스 도입 시점 반영: CI 게이트는 Phase 1 착수 시점부터, 런타임 순찰은 Phase 2부터.
5. 기존 §14 변경 이력은 §17로 이동.

### v1.2 (2026-08-07) — rank(숫자 레벨) 제거

발주자 검토 의견("레벨 방식은 효과 대비 복잡도·비용이 크다") 채택. 분석 결과 rank는 v1.1 시점에 이미 보안상 잉여였다 — 권한 상승 차단의 실질은 부분집합 검사가 담당했고, rank 규칙은 예외 조항(`SUPER_ADMIN` 부여 특례)만 낳고 있었다.

1. **rank 컬럼·규칙 전면 제거**: `roles.rank` → `display_order`(정렬·표시 전용, 보안 규칙 사용 금지). rank 상한 규칙, `SUPER_ADMIN` 부여 예외 규칙 삭제.
2. **관리 서열을 권한 집합 우위(Dominance) 비교로 대체 (§4.6)**: 관리 행위는 "행위자 유효 Permission 집합 ⊋ 대상자 집합"일 때만 허용. 동집합·비교불가는 거부. 역할 부여는 부분집합 검사 단일 규칙으로 통일.
3. **파생 효과**: `SUPER_ADMIN` 부여가 "전체 집합 보유자만 가능"으로 자동 도출되어 v1.1의 예외 조항(§4.6-2c) 소멸. 테넌트 관리자 격리(§9.2)도 별도 규칙 없이 부분집합 검사로 유지.
4. **INV-2 재정의**: "관리 서열은 데이터에서 파생한다" — 등급 숫자·레벨 필드의 보안 규칙 도입을 금지.
5. **가시성 보완 (§4.6-3)**: 파생 서열의 비직관성을 관리 콘솔의 관리 가능/불가 표시와 시뮬레이터로 보완.

### v1.1 (2026-08-07) — 레드팀 검토 반영

레드팀 검토에서 발견된 14건의 결함을 반영하였다. 주요 변경:

1. **[치명] Permission `scope`(global/owned) 도입 (§4.3, §4.7-3)**: 기존 평가기는 역할 보유 권한을 소유 여부와 무관하게 허용하여, 일반회원의 `file.read`가 전 파일 열람으로 오작동하는 결함이 있었다. scope 개념을 1급으로 도입하여 owned 권한은 소유 리소스에만 유효하도록 재정의. 이에 따라 도메인 관리용 `.all` 권한 4종 추가(총 26종).
2. **[높음] 역할 부여 시 권한 부분집합 검사 (§4.6-2b)**: rank 상한만으로는 "저rank·고권한 역할"을 통한 간접 상승이 가능했음. 부여 역할의 Permission이 부여자 보유분의 부분집합일 것을 필수화.
3. **[높음] `SUPER_ADMIN` 부여 예외 (§4.6-2c)**: rank 상한 규칙상 rank 100 역할을 누구도 부여할 수 없어 2인 이상 최고관리자 구성이 불가능했던 모순 해소.
4. **[높음] 최고관리자 보존 불변식 강화 (§10.1)**: "활성 SUPER_ADMIN ≥ 1"로 재정의, 검사·변경 원자화(FOR UPDATE), `expires_at` 금지로 만료 소멸 경로 제거.
5. **[높음] `OPERATOR`에 `member.role.assign`·`member.delete` 추가 (§4.5)**: 액터 정의·API 표와의 정합성 회복.
6. **[중간] 리소스 상태 게이트 추가 (§4.7-1)**: 소프트 삭제·정지된 리소스에 대한 소유자/전역 권한 경로 접근 차단.
7. **[중간] 감사 기록의 트랜잭션 내 수행 명시 (§7.4)**: 인터셉터 사후 기록으로는 INV-6(감사 실패 시 롤백)이 구현 불가능한 모순 해소.
8. **[중간] 캐시 무효화 강화 (§8.3)**: 권위 소스를 DB perm_version으로 단일화, 무효화 순서(pv 증가 → 키 삭제) 강제, 역할-매핑 변경 시에도 보유자 pv 배치 증가(백스톱), 스냅샷에 status 포함.
9. **[중간] 정지·삭제 시 리프레시 토큰 패밀리 폐기 + 갱신 시 상태 재검증 (MEM-4/6, AUTH-3)**.
10. **[중간] 관계형 2차 인가 표준 패턴 정의 (§7.3)**: "소유자 또는 공유 생성자" 류 조건의 구현 방식 명문화.
11. **[중간] 멀티테넌트 무결성 보강 (§5.2, §9.2)**: 매핑 테이블에 `tenant_id` 예약 컬럼 추가, 교차 테넌트 부여 차단, 로그인 테넌트 식별, 테넌트 관리자 부트스트랩 절차 명시.
12. **[낮음] `resource_grants` UNIQUE에서 `effect` 제외 (§5.2)**: ALLOW/DENY 동시 존재 모순 차단. Grant 화이트리스트 검증 규칙 추가(§5.3).
13. **[낮음] 인덱스 보강 (§5.2)**: `user_roles(role_id)`, `refresh_tokens(family_id)`, `refresh_tokens(user_id)`.
14. **[낮음] "소유자 행위 집합" 미정의 용어 제거**: scope 도입으로 흡수.

---

*문서 끝.*
