/*
  Warnings:

  - You are about to drop the column `search_tsv` on the `posts` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "board_capabilities" DROP CONSTRAINT "fk_bcaps_board";

-- DropForeignKey
ALTER TABLE "board_members" DROP CONSTRAINT "fk_bmembers_board";

-- DropForeignKey
ALTER TABLE "board_members" DROP CONSTRAINT "fk_bmembers_user";

-- DropForeignKey
ALTER TABLE "boards" DROP CONSTRAINT "fk_boards_created_by";

-- DropForeignKey
ALTER TABLE "boards" DROP CONSTRAINT "fk_boards_tenant";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "fk_comments_owner";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "fk_comments_parent";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "fk_comments_post";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "fk_comments_tenant";

-- DropForeignKey
ALTER TABLE "post_attachments" DROP CONSTRAINT "fk_pattach_file";

-- DropForeignKey
ALTER TABLE "post_attachments" DROP CONSTRAINT "fk_pattach_post";

-- DropForeignKey
ALTER TABLE "posts" DROP CONSTRAINT "fk_posts_board";

-- DropForeignKey
ALTER TABLE "posts" DROP CONSTRAINT "fk_posts_owner";

-- DropForeignKey
ALTER TABLE "posts" DROP CONSTRAINT "fk_posts_tenant";

-- DropIndex
DROP INDEX "idx_posts_search";

-- AlterTable
ALTER TABLE "board_members" ALTER COLUMN "joined_at" SET DEFAULT now();

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
ALTER TABLE "posts" DROP COLUMN "search_tsv",
ALTER COLUMN "created_at" SET DEFAULT now(),
ALTER COLUMN "updated_at" SET DEFAULT now();

-- CreateTable
CREATE TABLE "board_outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "topic" VARCHAR(48) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "board_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(48) NOT NULL,
    "payload" JSONB NOT NULL,
    "source_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "read_at" TIMESTAMPTZ,

    CONSTRAINT "board_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_reactions" (
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "board_reactions_pkey" PRIMARY KEY ("post_id","user_id","kind")
);

-- CreateTable
CREATE TABLE "board_tags" (
    "post_id" UUID NOT NULL,
    "tag" VARCHAR(48) NOT NULL,

    CONSTRAINT "board_tags_pkey" PRIMARY KEY ("post_id","tag")
);

-- CreateIndex
CREATE INDEX "board_outbox_events_processed_at_created_at_idx" ON "board_outbox_events"("processed_at", "created_at");

-- CreateIndex
CREATE INDEX "board_notifications_user_id_read_at_created_at_idx" ON "board_notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "board_notifications_user_id_source_event_id_key" ON "board_notifications"("user_id", "source_event_id");

-- CreateIndex
CREATE INDEX "board_tags_tag_idx" ON "board_tags"("tag");
