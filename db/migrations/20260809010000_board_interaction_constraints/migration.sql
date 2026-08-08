-- board 모듈 WP-B3: 수기 FK (커널 모델에 관계 미선언 — OQ-2, db/README.md 등재)
ALTER TABLE board_outbox_events ADD CONSTRAINT fk_boutbox_tenant  FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE board_notifications ADD CONSTRAINT fk_bnotif_tenant   FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE board_notifications ADD CONSTRAINT fk_bnotif_user     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE board_reactions     ADD CONSTRAINT fk_breact_post     FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE board_reactions     ADD CONSTRAINT fk_breact_user     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE board_tags          ADD CONSTRAINT fk_btags_post      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
