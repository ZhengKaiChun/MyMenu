import { z } from 'zod';
import { token, digest, passwordHash, passwordMatches } from '../../core/security.mjs';
import { demand } from '../../core/errors.mjs';
export function accountSettingsRoutes(app, { db, route }) {
  route('GET', '/me/security', null, async (r) => ({
    username: r.user.username || '',
    passwordSet: !!r.user.password_hash,
    phoneBound: !!r.user.phone_hash,
  }));
  route(
    'POST',
    '/me/credentials',
    z
      .object({
        username: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_]{4,32}$/)
          .transform((x) => x.toLowerCase()),
        currentPassword: z.string().max(128).default(''),
        newPassword: z.string().min(10).max(128).optional(),
      })
      .strict(),
    async (r) =>
      db.transaction(async (tx) => {
        const u = (
          await tx.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
            r.user.id,
          ])
        ).rows[0];
        demand(u, 401, 'SESSION_EXPIRED', '请重新登录');
        if (u.password_hash)
          demand(
            await passwordMatches(r.body.currentPassword, u.password_hash),
            403,
            'PASSWORD_REQUIRED',
            '当前密码不正确',
          );
        else {
          demand(
            new Date(r.user.session_created) > new Date(Date.now() - 5 * 60000),
            403,
            'REAUTHENTICATE',
            '请先退出并重新登录，再设置账号密码',
          );
          demand(r.body.newPassword, 400, 'NEW_PASSWORD_REQUIRED', '首次设置需要填写密码');
        }
        demand(
          r.body.newPassword || r.body.username !== u.username,
          400,
          'NO_CHANGE',
          '账号没有变化',
        );
        const password = r.body.newPassword
          ? await passwordHash(r.body.newPassword)
          : u.password_hash;
        await tx.query('UPDATE users SET username=$2,password_hash=$3 WHERE id=$1', [
          u.id,
          r.body.username,
          password,
        ]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
        const raw = token();
        await tx.query(
          "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",
          [digest(raw), u.id],
        );
        return { token: raw, user: { id: u.id, nickname: u.nickname, avatarId: u.avatar_id } };
      }),
    { authLimit: true },
  );
}
