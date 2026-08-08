-- AlterTable
ALTER TABLE "owner_cleanup_jobs" ALTER COLUMN "created_at" SET DEFAULT now(),
ALTER COLUMN "updated_at" SET DEFAULT now();
