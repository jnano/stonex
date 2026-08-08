-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" VARCHAR(500),
    "secret_value" TEXT,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_settings_tenant_id_category_idx" ON "system_settings"("tenant_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_tenant_id_category_key_key" ON "system_settings"("tenant_id", "category", "key");

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 시스템 설정 수기 SQL (db/README.md 이중 관리 표에 등재)
-- 기존 테이블의 컬럼을 추가·변경·삭제하지 않는다(INV-7).
-- ─────────────────────────────────────────────────────────────────────────────

-- 비밀 항목은 secret_value 에만, 평문 항목은 value 에만 담긴다.
-- 둘 다 채우거나 둘 다 비면 어느 쪽을 읽어야 할지 코드가 알 수 없다.
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_value_shape_check"
  CHECK (
    (is_secret = true  AND value IS NULL) OR
    (is_secret = false AND secret_value IS NULL)
  );
