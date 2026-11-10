CREATE TABLE subscription_grants(user_id uuid NOT NULL REFERENCES users(id),template_id text NOT NULL,remaining integer NOT NULL DEFAULT 0 CHECK(remaining BETWEEN 0 AND 10),PRIMARY KEY(user_id,template_id));
ALTER TABLE notifications ADD COLUMN delivery_status text NOT NULL DEFAULT 'pending';
ALTER TABLE notifications ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX notifications_delivery ON notifications(delivery_status,created_at);
