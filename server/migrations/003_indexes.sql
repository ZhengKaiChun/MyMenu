CREATE UNIQUE INDEX identities_one_wechat_per_user ON identities(user_id) WHERE provider='wechat';
CREATE INDEX sessions_expiration ON sessions(expires_at);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX changes_line ON changes(line_id);
CREATE INDEX invitations_expiration ON invitations(expires_at);
CREATE INDEX shares_expiration ON shares(expires_at);
