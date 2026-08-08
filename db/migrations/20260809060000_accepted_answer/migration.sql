-- board 모듈 WP-B9: 답변 채택 (accepted-answer 기능모듈, §5.2 QNA)
-- 답변은 댓글이다 — 별도 리소스 없이 채택 대상만 가리킨다.
ALTER TABLE posts ADD COLUMN accepted_comment_id UUID;

-- 채택 댓글이 물리 삭제되면 채택도 풀린다(SET NULL) — 미해결로 돌아가는 것이 맞다
ALTER TABLE posts ADD CONSTRAINT fk_posts_accepted_comment
  FOREIGN KEY (accepted_comment_id) REFERENCES comments(id) ON DELETE SET NULL;

-- 미해결 질문 목록(§B9)의 조회 축 — 부분 인덱스로 좁힌다
CREATE INDEX idx_posts_unanswered ON posts (board_id, created_at DESC)
  WHERE accepted_comment_id IS NULL AND status = 'PUBLISHED' AND deleted_at IS NULL;
