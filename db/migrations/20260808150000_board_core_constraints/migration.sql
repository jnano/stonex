-- board 모듈: Prisma 미표현 제약 수기 SQL (스펙 §4, db/migrations/README.md 등재 대상)
-- 커널 모델에 관계를 선언하지 않으므로(OQ-2) FK 를 여기서 건다. 기존 테이블 무변경(INV-7).

-- FK — 커널 테이블 참조
ALTER TABLE boards            ADD CONSTRAINT fk_boards_tenant       FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE boards            ADD CONSTRAINT fk_boards_created_by   FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE board_members     ADD CONSTRAINT fk_bmembers_board      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE;
ALTER TABLE board_members     ADD CONSTRAINT fk_bmembers_user       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE board_capabilities ADD CONSTRAINT fk_bcaps_board        FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE;
ALTER TABLE posts             ADD CONSTRAINT fk_posts_tenant        FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE posts             ADD CONSTRAINT fk_posts_board         FOREIGN KEY (board_id) REFERENCES boards(id);
ALTER TABLE posts             ADD CONSTRAINT fk_posts_owner         FOREIGN KEY (owner_id) REFERENCES users(id);
ALTER TABLE comments          ADD CONSTRAINT fk_comments_tenant     FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE comments          ADD CONSTRAINT fk_comments_post       FOREIGN KEY (post_id) REFERENCES posts(id);
ALTER TABLE comments          ADD CONSTRAINT fk_comments_owner      FOREIGN KEY (owner_id) REFERENCES users(id);
ALTER TABLE comments          ADD CONSTRAINT fk_comments_parent     FOREIGN KEY (parent_id) REFERENCES comments(id);
ALTER TABLE post_attachments  ADD CONSTRAINT fk_pattach_post        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE post_attachments  ADD CONSTRAINT fk_pattach_file        FOREIGN KEY (file_id) REFERENCES files(id);

-- CHECK — 상태·가시성 어휘 고정
ALTER TABLE boards   ADD CONSTRAINT chk_boards_visibility CHECK (visibility IN ('PUBLIC','RESTRICTED','PRIVATE'));
ALTER TABLE boards   ADD CONSTRAINT chk_boards_status     CHECK (status IN ('ACTIVE','ARCHIVED','DELETED'));
ALTER TABLE posts    ADD CONSTRAINT chk_posts_status      CHECK (status IN ('DRAFT','PUBLISHED','HIDDEN','DELETED'));
ALTER TABLE comments ADD CONSTRAINT chk_comments_status   CHECK (status IN ('PUBLISHED','HIDDEN','DELETED'));

-- 부분 인덱스 (스펙 §4 — Prisma 미표현)
CREATE INDEX idx_posts_board_created ON posts (board_id, created_at DESC, id DESC) WHERE status = 'PUBLISHED';
CREATE INDEX idx_posts_board_pinned  ON posts (board_id, is_pinned) WHERE is_pinned;
CREATE INDEX idx_posts_owner         ON posts (owner_id) WHERE status <> 'DELETED';
CREATE INDEX idx_comments_owner      ON comments (owner_id) WHERE status <> 'DELETED';

-- 전문검색 벡터 (§8 — B4 에서 사용, 스키마는 지금 확정해 이후 ALTER 를 없앤다)
ALTER TABLE posts ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
  setweight(to_tsvector('simple', coalesce(body_md,'')), 'B')
) STORED;
CREATE INDEX idx_posts_search ON posts USING GIN (search_tsv);

-- updated_at 트리거 — 시간은 DB 가 관리한다(클라이언트 Date 시간대 문제 원천 차단)
CREATE OR REPLACE FUNCTION board_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_boards_touch   BEFORE UPDATE ON boards   FOR EACH ROW EXECUTE FUNCTION board_touch_updated_at();
CREATE TRIGGER trg_posts_touch    BEFORE UPDATE ON posts    FOR EACH ROW EXECUTE FUNCTION board_touch_updated_at();
CREATE TRIGGER trg_comments_touch BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION board_touch_updated_at();
