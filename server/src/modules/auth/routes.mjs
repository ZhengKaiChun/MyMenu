import { z } from 'zod';
import { phoneRoutes, smsEnabled } from './phone.mjs';
import { subscriptionEnabled } from '../notifications/wechat.mjs';
import { id, token, digest, passwordHash, passwordMatches } from '../../core/security.mjs';
import { demand } from '../../core/errors.mjs';
const credentials = z
  .object({
    username: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_]{4,32}$/)
      .transform((s) => s.toLowerCase()),
    password: z.string().min(10).max(128),
  })
  .strict();
async function wechatOpenid(config, code) {
  demand(config.wechatSecret, 503, 'WECHAT_NOT_CONFIGURED', '微信身份绑定尚未配置');
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({
    appid: config.appid,
    secret: config.wechatSecret,
    js_code: code,
    grant_type: 'authorization_code',
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  demand(response.ok, 502, 'WECHAT_UNAVAILABLE', '微信服务暂时不可用');
  const out = await response.json();
  demand(out.openid && !out.errcode, 401, 'WECHAT_CODE', '微信身份授权已过期，请重试');
  return out.openid;
}
export async function authRoutes(app, ctx) {
  const { db, config, route } = ctx;
  let dummy = await passwordHash('invalid-credential-dummy-2026');
  async function session(user) {
    const raw = token();
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",
      [digest(raw), user.id],
    );
    return { token: raw, user: { id: user.id, nickname: user.nickname, avatarId: user.avatar_id } };
  }
  route(
    'GET',
    '/capabilities',
    null,
    async () => ({
      wechat: !!config.wechatSecret,
      sms: smsEnabled(config, ctx.smsSender),
      wechatPhone: !!config.wechatSecret && !!config.phoneKey,
      password: true,
      subscriptionTemplateId: subscriptionEnabled(config) ? config.subscription.templateId : null,
      devAuth: config.allowDevAuth,
    }),
    { public: true },
  );
  route(
    'POST',
    '/auth/register',
    credentials,
    async (r) => {
      const b = r.body,
        hash = await passwordHash(b.password);
      let u = { id: id(), nickname: '野生小猪' };
      await db.query('INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)', [
        u.id,
        b.username,
        hash,
      ]);
      return session(u);
    },
    { public: true, authLimit: true },
  );
  route(
    'POST',
    '/auth/password',
    credentials,
    async (r) => {
      const u = (
        await db.query('SELECT * FROM users WHERE username=$1 AND deleted_at IS NULL', [
          r.body.username,
        ])
      ).rows[0];
      const valid = await passwordMatches(r.body.password, u?.password_hash || dummy);
      demand(valid && u, 401, 'INVALID_CREDENTIALS', '账号或密码不正确');
      return session(u);
    },
    { public: true, authLimit: true },
  );
  route(
    'POST',
    '/auth/wechat',
    z.object({ code: z.string().min(1).max(256) }).strict(),
    async (r) => {
      const openid = await wechatOpenid(config, r.body.code);
      const u = await db.transaction(async (tx) => {
        let existing = (
          await tx.query(
            "SELECT u.* FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='wechat' AND i.subject=$1 AND u.deleted_at IS NULL",
            [openid],
          )
        ).rows[0];
        if (existing) return existing;
        const uid = id();
        await tx.query('INSERT INTO users(id) VALUES($1)', [uid]);
        await tx.query("INSERT INTO identities(provider,subject,user_id) VALUES('wechat',$1,$2)", [
          openid,
          uid,
        ]);
        return { id: uid, nickname: '野生小猪' };
      });
      return session(u);
    },
    { public: true, authLimit: true },
  );
  phoneRoutes(ctx, session);
  route('POST', '/auth/logout', z.object({}).strict(), async (r) => {
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [r.tokenHash]);
    return { ok: true };
  });
  route(
    'POST',
    '/me/wechat/check',
    z.object({ code: z.string().min(1).max(256) }).strict(),
    async (r) => {
      const openid = await wechatOpenid(config, r.body.code);
      const bound = (
        await db.query(
          "SELECT u.id,u.username,u.nickname FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='wechat' AND i.subject=$1 AND u.deleted_at IS NULL",
          [openid],
        )
      ).rows[0];
      return {
        state: !bound ? 'available' : bound.id === r.user.id ? 'current' : 'other',
        account: bound ? bound.username || bound.nickname || '微信账号' : null,
      };
    },
    { authLimit: true },
  );
  route(
    'POST',
    '/me/wechat',
    z.object({ code: z.string().min(1).max(256) }).strict(),
    async (r) => {
      const openid = await wechatOpenid(config, r.body.code);
      await db.transaction(async (tx) => {
        let existing = (
          await tx.query("SELECT user_id FROM identities WHERE provider='wechat' AND subject=$1", [
            openid,
          ])
        ).rows[0];
        demand(
          !existing || existing.user_id === r.user.id,
          409,
          'IDENTITY_BOUND',
          '这个微信身份已绑定其他账号，请先使用原账号登录',
        );
        let own = (
          await tx.query("SELECT subject FROM identities WHERE provider='wechat' AND user_id=$1", [
            r.user.id,
          ])
        ).rows[0];
        demand(!own || own.subject === openid, 409, 'IDENTITY_BOUND', '此账号已绑定其他微信身份');
        if (!existing)
          await tx.query(
            "INSERT INTO identities(provider,subject,user_id) VALUES('wechat',$1,$2)",
            [openid, r.user.id],
          );
      });
      return { ok: true };
    },
  );
  route(
    'POST',
    '/me/wechat/unbind',
    z.object({ currentPassword: z.string().min(1).max(128) }).strict(),
    async (r) => {
      const valid = await passwordMatches(r.body.currentPassword, r.user.password_hash || dummy);
      demand(
        !!r.user.password_hash && valid && !!r.user.username,
        403,
        'PASSWORD_REQUIRED',
        '请先设置账号密码，并填写当前密码',
      );
      const removed = await db.query(
        "DELETE FROM identities WHERE provider='wechat' AND user_id=$1 RETURNING subject",
        [r.user.id],
      );
      demand(removed.rows.length, 409, 'WECHAT_NOT_BOUND', '此账号尚未绑定微信');
      return { ok: true };
    },
    { authLimit: true },
  );
  route('GET', '/me', null, async (r) => ({
    id: r.user.id,
    nickname: r.user.nickname,
    avatarId: r.user.avatar_id,
  }));
  route(
    'PATCH',
    '/me',
    z
      .object({
        nickname: z.string().trim().min(1).max(24),
        avatarId: z.uuid().nullable().optional(),
      })
      .strict(),
    async (r) => {
      if (r.body.avatarId) {
        const m = (
          await db.query('SELECT id FROM media WHERE id=$1 AND owner_id=$2', [
            r.body.avatarId,
            r.user.id,
          ])
        ).rows[0];
        demand(m, 400, 'MEDIA_OWNER', '头像文件不可用');
      }
      await db.query('UPDATE users SET nickname=$2,avatar_id=$3 WHERE id=$1', [
        r.user.id,
        r.body.nickname,
        r.body.avatarId || null,
      ]);
      return { ok: true };
    },
  );
}
