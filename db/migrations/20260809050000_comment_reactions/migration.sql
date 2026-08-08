-- board 모듈 WP-B6: 댓글 반응 (별도 테이블 — 기존 board_reactions 무변경)
CREATE TABLE "comment_reactions" (
  "comment_id" UUID NOT NULL,
  "user_id"    UUID NOT NULL,
  "kind"       VARCHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "comment_reactions_pkey" PRIMARY KEY ("comment_id", "user_id", "kind")
);

-- 수기 FK (커널 모델 관계 미선언 — OQ-2, db/README.md 등재)
ALTER TABLE comment_reactions ADD CONSTRAINT fk_creact_comment FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE;
ALTER TABLE comment_reactions ADD CONSTRAINT fk_creact_user    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
