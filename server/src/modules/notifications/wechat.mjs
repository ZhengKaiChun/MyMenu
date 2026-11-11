import { z } from 'zod';
import { demand } from '../../core/errors.mjs';
export function subscriptionEnabled(config) {
  return (
    !!config.wechatSecret &&
    !!config.subscription?.templateId &&
    Object.keys(config.subscription?.fields || {}).length > 0
  );
}
export function notificationRoutes(app, { db, config, route }) {
  route('GET', '/notifications/preferences', null, async (r) => ({
    enabled: (await db.query('SELECT notifications_enabled FROM users WHERE id=$1', [r.user.id]))
      .rows[0].notifications_enabled,
  }));
  route(
    'PATCH',
    '/notifications/preferences',
    z.object({ enabled: z.boolean() }).strict(),
    async (r) => {
      await db.query('UPDATE users SET notifications_enabled=$2 WHERE id=$1', [
        r.user.id,
        r.body.enabled,
      ]);
      return { enabled: r.body.enabled };
    },
  );
  route(
    'POST',
    '/notifications/subscribe',
    z.object({ templateId: z.string().min(1).max(128), accepted: z.boolean() }).strict(),
    async (r) => {
      demand(
        subscriptionEnabled(config) && r.body.templateId === config.subscription.templateId,
        400,
        'TEMPLATE_UNAVAILABLE',
        '订阅提醒尚未配置',
      );
      const identity = (
        await db.query("SELECT subject FROM identities WHERE user_id=$1 AND provider='wechat'", [
          r.user.id,
        ])
      ).rows[0];
      demand(identity, 409, 'WECHAT_NOT_BOUND', '请先绑定微信身份后订阅');
      if (r.body.accepted)
        await db.query(
          'INSERT INTO subscription_grants(user_id,template_id,remaining) VALUES($1,$2,1) ON CONFLICT(user_id,template_id) DO UPDATE SET remaining=LEAST(10,subscription_grants.remaining+1)',
          [r.user.id, r.body.templateId],
        );
      return { ok: true };
    },
  );
}
export function wechatNotificationSender(config) {
  let token = null,
    until = 0;
  return async (note) => {
    if (!token || Date.now() > until) {
      const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
      url.search = new URLSearchParams({
        grant_type: 'client_credential',
        appid: config.appid,
        secret: config.wechatSecret,
      });
      let r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      let body = await r.json();
      demand(body.access_token, 502, 'WECHAT_UNAVAILABLE', '微信提醒暂不可用');
      token = body.access_token;
      until = Date.now() + (body.expires_in - 120) * 1000;
    }
    const data = {},
      time = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date());
    for (const [key, value] of Object.entries(config.subscription.fields)) {
      demand(
        /^(thing|phrase|time|date|number|character_string)\d+$/.test(key) &&
          typeof value === 'string',
        500,
        'TEMPLATE_CONFIG',
        '订阅模板字段配置错误',
      );
      data[key] = {
        value: Array.from(value.replaceAll('{{body}}', note.body).replaceAll('{{time}}', time))
          .slice(0, 20)
          .join(''),
      };
    }
    let response = await fetch(
      'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token,
      {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: note.openid,
          template_id: config.subscription.templateId,
          page: 'pages/requests/index?familyId=' + note.family_id,
          data,
          miniprogram_state: 'formal',
          lang: 'zh_CN',
        }),
      },
    );
    let result = await response.json();
    if (result.errcode === 40001 || result.errcode === 42001) {
      token = null;
      until = 0;
    }
    return result.errcode || 0;
  };
}
export async function deliverNotifications(db, config, sender) {
  if (!subscriptionEnabled(config)) return { processed: 0 };
  let processed = 0;
  for (let i = 0; i < 5; i++) {
    const result = await db.transaction(async (tx) => {
      const note = (
        await tx.query(
          "SELECT n.*,u.notifications_enabled,i.subject AS openid,g.remaining FROM notifications n JOIN users u ON u.id=n.user_id LEFT JOIN identities i ON i.user_id=n.user_id AND i.provider='wechat' LEFT JOIN subscription_grants g ON g.user_id=n.user_id AND g.template_id=$1 WHERE n.delivery_status IN('pending','failed') AND n.delivery_attempts<3 AND n.created_at>now()-interval '1 day' ORDER BY n.created_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED",
          [config.subscription.templateId],
        )
      ).rows[0];
      if (!note) return false;
      if (
        !note.notifications_enabled ||
        !note.openid ||
        !note.remaining ||
        note.type === 'order.sent'
      ) {
        await tx.query("UPDATE notifications SET delivery_status='skipped' WHERE id=$1", [note.id]);
        return true;
      }
      const reserved = await tx.query(
        'UPDATE subscription_grants SET remaining=remaining-1 WHERE user_id=$1 AND template_id=$2 AND remaining>0 RETURNING user_id',
        [note.user_id, config.subscription.templateId],
      );
      if (!reserved.rows.length) return false;
      let code;
      try {
        code = await sender(note);
      } catch {
        code = -1;
      }
      let status = code === 0 ? 'delivered' : code === 43101 ? 'skipped' : 'failed';
      await tx.query(
        'UPDATE notifications SET delivery_status=$2,delivery_attempts=delivery_attempts+1 WHERE id=$1',
        [note.id, status],
      );
      return true;
    });
    if (!result) break;
    processed++;
  }
  return { processed };
}
