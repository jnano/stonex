-- CreateTable
CREATE TABLE "owner_cleanup_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "owner_cleanup_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_cleanup_jobs_status_updated_at_idx" ON "owner_cleanup_jobs"("status", "updated_at");
