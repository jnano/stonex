-- CreateTable
CREATE TABLE "domain_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(200),
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "domain_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_transfers_to_user_id_status_idx" ON "domain_transfers"("to_user_id", "status");

-- CreateIndex
CREATE INDEX "domain_transfers_from_user_id_status_idx" ON "domain_transfers"("from_user_id", "status");

-- CreateIndex
CREATE INDEX "domain_transfers_status_expires_at_idx" ON "domain_transfers"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "domain_transfers" ADD CONSTRAINT "domain_transfers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_transfers" ADD CONSTRAINT "domain_transfers_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- WP-13 수기 SQL (Prisma 미표현 — db/README.md 이중 관리 표에 등재)
--
-- 이 마이그레이션은 **기존 테이블의 컬럼을 추가·변경·삭제하지 않는다**(INV-7).
-- 이전 상태는 전적으로 신규 테이블 domain_transfers 에 담긴다.
-- ─────────────────────────────────────────────────────────────────────────────

-- 동시 발의 1건 제한. 없으면 같은 도메인에 발의를 여러 건 띄워 두고
-- 그중 하나를 골라 수락시키는 경합을 만들 수 있다.
CREATE UNIQUE INDEX "uq_domain_transfers_pending" ON "domain_transfers" ("domain_id")
  WHERE status = 'PENDING';

-- status CHECK — 오타 상태값은 만료 스윕에도 수락 경로에도 걸리지 않는 좀비 발의가 된다.
ALTER TABLE "domain_transfers" ADD CONSTRAINT "domain_transfers_status_check"
  CHECK (status IN ('PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED', 'INVALIDATED'));

-- 자기 자신에게 이전하는 발의는 DB 수준에서도 막는다(§10.1 과 동형 — 애플리케이션 검증의 이중화).
ALTER TABLE "domain_transfers" ADD CONSTRAINT "domain_transfers_not_self_check"
  CHECK (from_user_id <> to_user_id);
