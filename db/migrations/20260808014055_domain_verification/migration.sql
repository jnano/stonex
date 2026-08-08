-- ─────────────────────────────────────────────────────────────────────────────
-- WP-12. 도메인 기본 기능 (DOM-1~4·7)
--
-- 아래 부분 인덱스 3종은 Prisma 스키마가 표현하지 못해 수기로 관리한다.
-- **db/README.md 의 "Prisma-수기 SQL 이중 관리 지점" 표에 등재되어 있다** — 스키마를 손댈 때
-- 그 표와의 정합을 반드시 확인할 것.
-- ─────────────────────────────────────────────────────────────────────────────

-- DropIndex — 전체 유니크는 소프트 삭제와 양립하지 못한다.
-- 삭제된 행이 (tenant_id, fqdn) 슬롯을 계속 점유해 **같은 도메인을 영원히 재등록할 수 없었다.**
DROP INDEX "domains_tenant_id_fqdn_key";

-- 살아있는 행에 대해서만 FQDN 유일성을 강제한다.
-- fqdn 은 애플리케이션이 항상 정규형(소문자·후행 점 제거·punycode)으로 저장한다 —
-- 정규화 없이 이 인덱스만 두면 `EXAMPLE.com` 과 `example.com` 이 서로 다른 행이 되어
-- 중복 방지가 무력화되고, 같은 도메인을 두 사람이 각각 VERIFIED 로 만들 수 있다.
CREATE UNIQUE INDEX "uq_domains_fqdn_live" ON "domains" ("tenant_id", "fqdn") WHERE deleted_at IS NULL;

-- DOM-1 "내 도메인 목록" — 현재 domains 에는 owner_id 인덱스가 없어 전체 스캔이었다.
CREATE INDEX "idx_domains_owner" ON "domains" ("owner_id") WHERE deleted_at IS NULL;

-- CreateTable
CREATE TABLE "domain_verification_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "method" VARCHAR(20) NOT NULL DEFAULT 'DNS_TXT',
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "domain_verification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_verification_attempts_state_created_at_idx" ON "domain_verification_attempts"("state", "created_at");

-- CreateIndex
CREATE INDEX "domain_verification_attempts_domain_id_created_at_idx" ON "domain_verification_attempts"("domain_id", "created_at");

-- AddForeignKey
ALTER TABLE "domain_verification_attempts" ADD CONSTRAINT "domain_verification_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_verification_attempts" ADD CONSTRAINT "domain_verification_attempts_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 도메인당 진행 중 검증은 1건으로 제한한다. 요청은 인증만 통과하면 무제한으로 쌓을 수 있고,
-- 검증 1건은 외부 DNS 조회(최대 3초 × 재시도)를 소비하므로 이 제약이 없으면
-- **요청 폭주가 그대로 워커 포화**가 된다. 쿨다운·일일 상한은 애플리케이션이 추가로 강제한다.
CREATE UNIQUE INDEX "uq_domain_verification_inflight" ON "domain_verification_attempts" ("domain_id")
  WHERE state IN ('PENDING', 'RUNNING');

-- state CHECK — 잡 상태는 4종뿐이다. 오타 상태값이 들어가면 워커가 영원히 집지 못하는 좀비 행이 된다.
ALTER TABLE "domain_verification_attempts" ADD CONSTRAINT "domain_verification_attempts_state_check"
  CHECK (state IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'));
