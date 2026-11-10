import { randomBytes } from 'node:crypto';
export function configFromEnv(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (production) {
    for (const key of [
      'DATABASE_URL',
      'PUBLIC_ORIGIN',
      'TOKEN_PEPPER',
      'MEDIA_SIGNING_KEY',
      'WECHAT_SECRET',
    ])
      if (!env[key]) throw new Error('Missing production setting: ' + key);
    if (!env.PUBLIC_ORIGIN.startsWith('https://')) throw new Error('Production requires HTTPS');
    for (const key of ['TOKEN_PEPPER', 'MEDIA_SIGNING_KEY'])
      if (env[key].length < 32) throw new Error(key + ' must be at least 32 characters');
    if (env.PHONE_ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(env.PHONE_ENCRYPTION_KEY))
      throw new Error('PHONE_ENCRYPTION_KEY must be 32 bytes hex');
    if (env.ALLOW_DEV_AUTH === 'true')
      throw new Error('Development authentication cannot run in production');
  }
  return {
    production,
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    origin: env.PUBLIC_ORIGIN || 'http://127.0.0.1:3000',
    database: {
      url: env.DATABASE_URL,
      directory: env.DATABASE_DIR || '.runtime/postgres',
      ssl: env.DATABASE_SSL === 'true',
    },
    appid: env.WECHAT_APPID || 'wx3ab03337b159fadd',
    wechatSecret: env.WECHAT_SECRET || '',
    mediaKey: env.MEDIA_SIGNING_KEY || randomBytes(32).toString('hex'),
    pepper: env.TOKEN_PEPPER || randomBytes(32).toString('hex'),
    allowDevAuth: env.ALLOW_DEV_AUTH === 'true',
    phoneKey: env.PHONE_ENCRYPTION_KEY || '',
    sms: {
      secretId: env.SMS_SECRET_ID,
      secretKey: env.SMS_SECRET_KEY,
      appId: env.SMS_APP_ID,
      signName: env.SMS_SIGN_NAME,
      templateId: env.SMS_TEMPLATE_ID,
      region: env.SMS_REGION || 'ap-guangzhou',
      withMinutes: env.SMS_WITH_MINUTES === 'true',
    },
    mediaDir: env.MEDIA_DIR || '.runtime/media',
  };
}
