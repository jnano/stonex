-- CreateTable
CREATE TABLE "email_change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "new_email" VARCHAR(255) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ,

    CONSTRAINT "email_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_change_requests_token_hash_key" ON "email_change_requests"("token_hash");

-- CreateIndex
CREATE INDEX "email_change_requests_user_id_status_idx" ON "email_change_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "email_change_requests_status_expires_at_idx" ON "email_change_requests"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- MEM-1 수기 SQL (db/README.md 이중 관리 표에 등재)
-- 이 마이그레이션도 **기존 테이블의 컬럼을 추가·변경·삭제하지 않는다**(INV-7).
-- ─────────────────────────────────────────────────────────────────────────────

-- 사용자당 진행 중 변경 요청은 1건. 없으면 여러 주소로 동시에 요청을 띄워 두고
-- 그중 하나를 골라 확인하는 경합을 만들 수 있다.
CREATE UNIQUE INDEX "uq_email_change_pending" ON "email_change_requests" ("user_id")
  WHERE status = 'PENDING';

ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_status_check"
  CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'));
