import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError, z } from 'zod';
import { createDatabase, migrate } from './core/db.mjs';
import { digest, id } from './core/security.mjs';
import { demand } from './core/errors.mjs';
import { configFromEnv } from './config.mjs';
import { authRoutes } from './modules/auth/routes.mjs';
import { familyRoutes } from './modules/families/routes.mjs';
import { recipeRoutes } from './modules/recipes/routes.mjs';
import { mealRoutes } from './modules/meals/routes.mjs';
import { inventoryRoutes } from './modules/inventory/routes.mjs';
import { changeRoutes } from './modules/changes/routes.mjs';
import { shareRoutes } from './modules/shares/routes.mjs';
import { dissolutionRoutes } from './modules/dissolutions/routes.mjs';
import { mediaRoutes } from './modules/media/routes.mjs';
import { notificationRoutes } from './modules/notifications/wechat.mjs';
export async function buildApp(options = {}) {
  const config = options.config || configFromEnv(),
    db = options.db || (await createDatabase(config.database));
  await migrate(db);
  const app = Fastify({
    logger: options.logger ?? {
      level: config.production ? 'info' : 'warn',
      redact: ['req.headers.authorization', 'req.url', 'req.body', 'password', 'token'],
    },
    bodyLimit: 512 * 1024,
    trustProxy: config.trustProxyHops || false,
    genReqId: () => id(),
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute', keyGenerator: (r) => r.ip });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
  });
  app.setErrorHandler((e, r, reply) => {
    let status =
      e instanceof ZodError
        ? 400
        : e.statusCode || (['23505', '23503', '23514'].includes(e.code) ? 409 : 500);
    if (status >= 500)
      r.log.error({ code: e.code || 'INTERNAL', requestId: r.id }, 'Request failed');
    reply.code(status).send({
      error: {
        code:
          e instanceof ZodError
            ? 'VALIDATION'
            : status >= 500
              ? 'INTERNAL'
              : ['23505', '23503', '23514'].includes(e.code)
                ? 'DATA_CONFLICT'
                : e.code || 'REQUEST_ERROR',
        message:
          e instanceof ZodError
            ? '填写内容格式有误，请检查输入'
            : status >= 500
              ? '服务暂时不可用，请稍后重试'
              : ['23505', '23503', '23514'].includes(e.code)
                ? '数据已变化或名称重复，请刷新后重试'
                : e.message || '操作失败',
        requestId: r.id,
      },
    });
  });
  app.addHook('onSend', async (r, reply, payload) => {
    reply.header('X-Request-ID', r.id);
    return payload;
  });
  const route = (method, url, body, handler, options = {}) =>
    app.route({
      method,
      url,
      config: options.authLimit ? { rateLimit: { max: 8, timeWindow: '1 minute' } } : undefined,
      preHandler: async (r) => {
        for (const [key, value] of Object.entries(r.params || {})) {
          if (key !== 'token') z.uuid().parse(value);
          else
            z.string()
              .regex(/^[A-Za-z0-9_-]{30,100}$/)
              .parse(value);
        }
        if (!options.public) {
          let raw = r.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
          demand(raw, 401, 'UNAUTHENTICATED', '请先登录');
          let session = (
            await db.query(
              'SELECT u.*,s.created_at AS session_created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.deleted_at IS NULL',
              [digest(raw)],
            )
          ).rows[0];
          demand(session, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
          r.user = session;
          r.tokenHash = digest(raw);
        }
        if (body) r.body = body.parse(r.body || {});
      },
      handler,
    });
  const ctx = { db, config, route, smsSender: options.smsSender };
  await authRoutes(app, ctx);
  for (const register of [
    familyRoutes,
    recipeRoutes,
    mealRoutes,
    inventoryRoutes,
    changeRoutes,
    shareRoutes,
    dissolutionRoutes,
    mediaRoutes,
    notificationRoutes,
  ])
    register(app, ctx);
  route('DELETE', '/me', z.object({ confirm: z.literal(true) }).strict(), async (r) =>
    db.transaction(async (tx) => {
      demand(
        new Date(r.user.session_created) > new Date(Date.now() - 5 * 60000),
        403,
        'REAUTHENTICATE',
        '请重新登录后再注销账号',
      );
      let families = (
        await tx.query('SELECT id FROM families WHERE owner_id=$1 AND deleted_at IS NULL', [
          r.user.id,
        ])
      ).rows;
      demand(!families.length, 409, 'OWNED_FAMILIES', '请先转让或按全员确认流程解散你创建的小家');
      await tx.query(
        "UPDATE dissolutions SET status='invalidated' WHERE status='pending' AND family_id IN(SELECT family_id FROM members WHERE user_id=$1)",
        [r.user.id],
      );
      await tx.query('DELETE FROM members WHERE user_id=$1', [r.user.id]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [r.user.id]);
      await tx.query('DELETE FROM identities WHERE user_id=$1', [r.user.id]);
      await tx.query(
        "UPDATE users SET deleted_at=now(),nickname='已注销小猪',username=NULL,password_hash=NULL,avatar_id=NULL,phone_cipher=NULL,phone_hash=NULL WHERE id=$1",
        [r.user.id],
      );
      return { ok: true };
    }),
  );
  app.get('/health', async () => ({ ok: true, version: '0.2.0-rc.1' }));
  app.addHook('onClose', async () => {
    if (!options.db) await db.close();
  });
  return { app, db, config };
}
