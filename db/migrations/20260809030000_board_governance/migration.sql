-- board 모듈 WP-B5 (재작성): migrate dev 가 수기 SQL(FK·trgm 인덱스)을 드리프트로
-- 오인해 DROP 8건을 끼워 넣고, UTC 타임스탬프가 수동 타임스탬프(수기 FK)보다 앞서
-- 정렬돼 CI 에서 P3018 로 실패했다. DROP 을 제거하고 순서를 수기 FK 뒤로 옮겨 재작성.
-- (수기 SQL 관례가 있는 이 저장소에서 migrate dev 는 쓰지 않는다 — 수동 폴더 + deploy 만)

-- AlterTable
ALTER TABLE "board_members" ALTER COLUMN "joined_at" SET DEFAULT now();

-- AlterTable
ALTER TABLE "board_notifications" ALTER COLUMN "created_at" SET DEFAULT now();

-- AlterTable
ALTER TABLE "board_outbox_events" ALTER COLUMN "created_at" SET DEFAULT now();

-- AlterTable
ALTER TABLE "board_reactions" ALTER COLUMN "created_at" SET DEFAULT now();

-- AlterTable
ALTER TABLE "boards" ALTER COLUMN "created_at" SET DEFAULT now(),
ALTER COLUMN "updated_at" SET DEFAULT now();

-- AlterTable
ALTER TABLE "comments" ALTER COLUMN "created_at" SET DEFAULT now(),
ALTER COLUMN "updated_at" SET DEFAULT now();

-- AlterTable
ALTER TABLE "owner_cleanup_jobs" ALTER COLUMN "created_at" SET DEFAULT now(),
ALTER COLUMN "updated_at" SET DEFAULT now();

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "is_secret" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "created_at" SET DEFAULT now(),
ALTER COLUMN "updated_at" SET DEFAULT now();

-- CreateTable
CREATE TABLE "post_secret_readers" (
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "post_secret_readers_pkey" PRIMARY KEY ("post_id","user_id")
);

-- CreateTable
CREATE TABLE "post_authors" (
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "post_authors_pkey" PRIMARY KEY ("post_id","user_id")
);

-- CreateTable
CREATE TABLE "user_blocks" (
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id","blocked_id")
);

-- CreateTable
CREATE TABLE "board_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "board_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "board_reports_tenant_id_status_created_at_idx" ON "board_reports"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "board_reports_post_id_reporter_id_key" ON "board_reports"("post_id", "reporter_id");
