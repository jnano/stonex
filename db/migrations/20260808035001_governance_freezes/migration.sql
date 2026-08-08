-- CreateTable
CREATE TABLE "governance_freezes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trigger" VARCHAR(50) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "frozen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ,
    "released_by" UUID,
    "release_note" VARCHAR(300),

    CONSTRAINT "governance_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "governance_freezes_user_id_status_idx" ON "governance_freezes"("user_id", "status");

-- CreateIndex
CREATE INDEX "governance_freezes_tenant_id_status_idx" ON "governance_freezes"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "governance_freezes" ADD CONSTRAINT "governance_freezes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governance_freezes" ADD CONSTRAINT "governance_freezes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- WP-14b 수기 SQL (db/README.md 이중 관리 표에 등재)
-- 이 마이그레이션도 **기존 테이블의 컬럼을 추가·변경·삭제하지 않는다**(INV-7).
-- ─────────────────────────────────────────────────────────────────────────────

-- 한 사용자에게 활성 동결은 1건만. 없으면 같은 사유로 동결이 중복 적재되어
-- 해제 승인이 몇 건을 풀어야 하는지가 불분명해진다.
CREATE UNIQUE INDEX "uq_governance_freezes_active" ON "governance_freezes" ("user_id")
  WHERE status = 'ACTIVE';

ALTER TABLE "governance_freezes" ADD CONSTRAINT "governance_freezes_status_check"
  CHECK (status IN ('ACTIVE', 'RELEASED'));

-- **자기 자신의 동결을 스스로 해제할 수 없다**(§14.4). 서비스가 먼저 막지만,
-- 이 제약이 있어야 서비스를 우회한 직접 UPDATE 도 성립하지 않는다.
ALTER TABLE "governance_freezes" ADD CONSTRAINT "governance_freezes_not_self_release_check"
  CHECK (released_by IS NULL OR released_by <> user_id);
