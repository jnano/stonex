-- AlterTable
ALTER TABLE "owner_cleanup_jobs" ALTER COLUMN "created_at" SET DEFAULT now(),
ALTER COLUMN "updated_at" SET DEFAULT now();

-- CreateTable
CREATE TABLE "boards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "board_type" VARCHAR(32) NOT NULL DEFAULT 'FORUM',
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'PUBLIC',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "post_count" BIGINT NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_members" (
    "board_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "board_role" VARCHAR(16) NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "board_members_pkey" PRIMARY KEY ("board_id","user_id")
);

-- CreateTable
CREATE TABLE "board_capabilities" (
    "board_id" UUID NOT NULL,
    "capability_key" VARCHAR(48) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "board_capabilities_pkey" PRIMARY KEY ("board_id","capability_key")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "body_md" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "comment_count" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "parent_id" UUID,
    "path" TEXT NOT NULL,
    "depth" SMALLINT NOT NULL DEFAULT 0,
    "body_md" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_attachments" (
    "post_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "post_attachments_pkey" PRIMARY KEY ("post_id","file_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "boards_tenant_id_slug_key" ON "boards"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "board_members_user_id_idx" ON "board_members"("user_id");

-- CreateIndex
CREATE INDEX "idx_posts_board_created_all" ON "posts"("board_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "comments_post_id_path_idx" ON "comments"("post_id", "path");
