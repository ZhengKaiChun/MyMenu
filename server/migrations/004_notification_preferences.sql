ALTER TABLE users ADD COLUMN notifications_enabled boolean NOT NULL DEFAULT true;

-- Preserve access to previous requests when the inbox becomes an event list.
INSERT INTO notifications(id,user_id,family_id,type,entity_id,body,created_at,delivery_status)
SELECT gen_random_uuid(),o.user_id,o.family_id,'order.sent',o.id,'你点的菜已收到，点击查看回音',o.created_at,'skipped'
FROM orders o WHERE o.created_at > now()-interval '3 months'
AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.user_id=o.user_id AND n.entity_id=o.id AND n.type='order.sent');
