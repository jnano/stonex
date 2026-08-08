-- board 모듈 WP-B5: 수기 FK·CHECK (커널 모델 관계 미선언 — OQ-2, db/README.md 등재)
ALTER TABLE post_secret_readers ADD CONSTRAINT fk_psecret_post  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE post_secret_readers ADD CONSTRAINT fk_psecret_user  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE post_authors        ADD CONSTRAINT fk_pauthors_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE post_authors        ADD CONSTRAINT fk_pauthors_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_blocks         ADD CONSTRAINT fk_ublocks_blocker FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_blocks         ADD CONSTRAINT fk_ublocks_blocked FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE board_reports       ADD CONSTRAINT fk_breports_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE board_reports       ADD CONSTRAINT fk_breports_post   FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE board_reports       ADD CONSTRAINT fk_breports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id);
ALTER TABLE board_reports       ADD CONSTRAINT chk_breports_status CHECK (status IN ('OPEN','UPHELD','DISMISSED'));
ALTER TABLE board_reports       ADD CONSTRAINT chk_breports_no_self CHECK (reporter_id IS NOT NULL);
