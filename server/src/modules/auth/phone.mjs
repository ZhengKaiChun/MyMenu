import { z } from 'zod';
import { randomInt, randomBytes, createCipheriv, createHmac } from 'node:crypto';
import { id, sign, equalHex, passwordHash, digest } from '../../core/security.mjs';
import { demand } from '../../core/errors.mjs';
const phone = z.string().regex(/^1[3-9]\d{9}$/),
  code = z.string().regex(/^\d{6}$/);
export function smsEnabled(config, sender) {
  return (
    !!config.phoneKey &&
    !!(
      sender ||
      (config.sms?.secretId &&
        config.sms?.secretKey &&
        config.sms?.appId &&
        config.sms?.signName &&
        config.sms?.templateId)
    )
  );
}
export function encryptPhone(value, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv),
    data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export async function sendTencentSms(config, number, value) {
  const timestamp = Math.floor(Date.now() / 1000),
    date = new Date(timestamp * 1000).toISOString().slice(0, 10),
    host = 'sms.tencentcloudapi.com',
    payload = JSON.stringify({
      PhoneNumberSet: ['+86' + number],
      SmsSdkAppId: config.appId,
      SignName: config.signName,
      TemplateId: config.templateId,
      TemplateParamSet: config.withMinutes ? [value, '5'] : [value],
    }),
    headers = ['content-type:application/json', 'host:' + host, ''].join(String.fromCharCode(10)),
    canonical = ['POST', '/', '', headers, 'content-type;host', digest(payload)].join(
      String.fromCharCode(10),
    ),
    scope = date + '/sms/tc3_request',
    string = ['TC3-HMAC-SHA256', timestamp, scope, digest(canonical)].join(String.fromCharCode(10)),
    h = (k, v) => createHmac('sha256', k).update(v).digest(),
    signature = h(h(h(h('TC3' + config.secretKey, date), 'sms'), 'tc3_request'), string).toString(
      'hex',
    );
  const response = await fetch('https://' + host, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: {
      'Content-Type': 'application/json',
      'X-TC-Action': 'SendSms',
      'X-TC-Version': '2021-01-11',
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': config.region || 'ap-guangzhou',
      Authorization:
        'TC3-HMAC-SHA256 Credential=' +
        config.secretId +
        '/' +
        scope +
        ', SignedHeaders=content-type;host, Signature=' +
        signature,
    },
    body: payload,
  });
  demand(response.ok, 502, 'SMS_PROVIDER', '验证码暂时发不出去，请稍后再试');
  let data = await response.json();
  demand(
    data.Response?.SendStatusSet?.[0]?.Code === 'Ok',
    502,
    'SMS_PROVIDER',
    '验证码暂时发不出去，请稍后再试',
  );
}
export function phoneRoutes(ctx, session) {
  const { db, config, route } = ctx,
    hash = (n) => sign(config.pepper, 'phone:' + n);
  async function verify(number, value) {
    const result = await db.transaction(async (tx) => {
      let challenge = (
        await tx.query('SELECT * FROM sms_challenges WHERE phone_hash=$1 FOR UPDATE', [
          hash(number),
        ])
      ).rows[0];
      if (!challenge || new Date(challenge.expires_at) < new Date() || challenge.attempts >= 5)
        return false;
      await tx.query('UPDATE sms_challenges SET attempts=attempts+1 WHERE phone_hash=$1', [
        hash(number),
      ]);
      if (!equalHex(challenge.code_hash, sign(config.pepper, number + ':' + value))) return false;
      await tx.query('DELETE FROM sms_challenges WHERE phone_hash=$1', [hash(number)]);
      return true;
    });
    demand(result, 401, 'SMS_CODE', '验证码不正确或已过期');
  }
  async function phoneUser(number) {
    return db.transaction(async (tx) => {
      let old = (
        await tx.query('SELECT * FROM users WHERE phone_hash=$1 AND deleted_at IS NULL', [
          hash(number),
        ])
      ).rows[0];
      if (old) return old;
      const uid = id();
      await tx.query('INSERT INTO users(id,phone_hash,phone_cipher) VALUES($1,$2,$3)', [
        uid,
        hash(number),
        encryptPhone(number, config.phoneKey),
      ]);
      return { id: uid, nickname: '野生小猪' };
    });
  }
  route(
    'POST',
    '/auth/sms/send',
    z.object({ phone }).strict(),
    async (r) => {
      demand(
        smsEnabled(config, ctx.smsSender),
        503,
        'SMS_UNAVAILABLE',
        '短信服务未启用，请使用微信或账号登录',
      );
      const value = String(randomInt(100000, 1000000)),
        number = r.body.phone;
      await db.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO sms_challenges(phone_hash,code_hash,expires_at,sent_at) VALUES($1,$2,now(),to_timestamp(0)) ON CONFLICT DO NOTHING',
          [hash(number), ''],
        );
        let old = (
          await tx.query('SELECT * FROM sms_challenges WHERE phone_hash=$1 FOR UPDATE', [
            hash(number),
          ])
        ).rows[0];
        demand(
          new Date(old.sent_at) < new Date(Date.now() - 60000),
          429,
          'SMS_COOLDOWN',
          '请稍后再获取验证码',
        );
        for (const [kind, key, max] of [
          ['phone', hash(number), 5],
          ['ip', sign(config.pepper, r.ip), 20],
        ]) {
          let n = await tx.query(
            'INSERT INTO sms_limits(kind,subject,day,count) VALUES($1,$2,current_date,1) ON CONFLICT(kind,subject,day) DO UPDATE SET count=sms_limits.count+1 WHERE sms_limits.count<$3 RETURNING count',
            [kind, key, max],
          );
          demand(n.rows.length, 429, 'SMS_DAILY_LIMIT', '今日验证码请求较多，请明天再试');
        }
        await tx.query(
          "UPDATE sms_challenges SET code_hash=$2,expires_at=now()+interval '5 minutes',attempts=0,sent_at=now() WHERE phone_hash=$1",
          [hash(number), sign(config.pepper, number + ':' + value)],
        );
      });
      try {
        await (ctx.smsSender
          ? ctx.smsSender(number, value)
          : sendTencentSms(config.sms, number, value));
      } catch (e) {
        await db.query('DELETE FROM sms_challenges WHERE phone_hash=$1 AND code_hash=$2', [
          hash(number),
          sign(config.pepper, number + ':' + value),
        ]);
        throw e;
      }
      return { sent: true, retryAfter: 60 };
    },
    { public: true, authLimit: true },
  );
  route(
    'POST',
    '/auth/sms',
    z.object({ phone, code }).strict(),
    async (r) => {
      demand(smsEnabled(config, ctx.smsSender), 503, 'SMS_UNAVAILABLE', '短信服务未启用');
      await verify(r.body.phone, r.body.code);
      return session(await phoneUser(r.body.phone));
    },
    { public: true, authLimit: true },
  );
  route(
    'POST',
    '/auth/recover',
    z.object({ phone, code, password: z.string().min(10).max(128) }).strict(),
    async (r) => {
      demand(smsEnabled(config, ctx.smsSender), 503, 'SMS_UNAVAILABLE', '短信找回暂未启用');
      await verify(r.body.phone, r.body.code);
      const password = await passwordHash(r.body.password);
      await db.transaction(async (tx) => {
        const u = (
          await tx.query(
            'UPDATE users SET password_hash=$2 WHERE phone_hash=$1 AND deleted_at IS NULL RETURNING id',
            [hash(r.body.phone), password],
          )
        ).rows[0];
        if (u) await tx.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
      });
      return { ok: true };
    },
    { public: true, authLimit: true },
  );
  route('POST', '/me/phone', z.object({ phone, code }).strict(), async (r) => {
    demand(smsEnabled(config, ctx.smsSender), 503, 'SMS_UNAVAILABLE', '短信服务未启用');
    await verify(r.body.phone, r.body.code);
    await db.query('UPDATE users SET phone_hash=$2,phone_cipher=$3 WHERE id=$1', [
      r.user.id,
      hash(r.body.phone),
      encryptPhone(r.body.phone, config.phoneKey),
    ]);
    return { ok: true };
  });
  let accessToken = null,
    expires = 0;
  route(
    'POST',
    '/auth/wechat-phone',
    z.object({ code: z.string().min(1).max(256) }).strict(),
    async (r) => {
      demand(
        config.wechatSecret && config.phoneKey,
        503,
        'WECHAT_PHONE_UNAVAILABLE',
        '微信手机号登录未启用',
      );
      if (!accessToken || Date.now() > expires) {
        const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
        url.search = new URLSearchParams({
          grant_type: 'client_credential',
          appid: config.appid,
          secret: config.wechatSecret,
        });
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const out = await response.json();
        demand(out.access_token, 502, 'WECHAT_TOKEN', '微信手机号登录暂不可用');
        accessToken = out.access_token;
        expires = Date.now() + (out.expires_in - 120) * 1000;
      }
      const response = await fetch(
        'https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=' + accessToken,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: r.body.code }),
          signal: AbortSignal.timeout(8000),
        },
      );
      const out = await response.json();
      demand(
        out.errcode === 0 && out.phone_info?.purePhoneNumber,
        401,
        'WECHAT_PHONE',
        '手机号授权已失效，请重试',
      );
      const number = phone.parse(out.phone_info.purePhoneNumber);
      return session(await phoneUser(number));
    },
    { public: true, authLimit: true },
  );
}
