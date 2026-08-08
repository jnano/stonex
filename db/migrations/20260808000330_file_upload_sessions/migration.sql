-- CreateTable
CREATE TABLE "file_uploads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "expected_mime" VARCHAR(127) NOT NULL,
    "max_bytes" BIGINT NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_uploads_requester_id_state_idx" ON "file_uploads"("requester_id", "state");

-- CreateIndex
CREATE INDEX "file_uploads_state_expires_at_idx" ON "file_uploads"("state", "expires_at");

-- AddForeignKey
ALTER TABLE "file_uploads" ADD CONSTRAINT "file_uploads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_uploads" ADD CONSTRAINT "file_uploads_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
