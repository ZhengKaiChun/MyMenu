import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.mjs';
import { pruneHistory } from '../src/jobs/retention.mjs';
import { token, digest } from '../src/core/security.mjs';
const config = {
  production: false,
  database: {},
  origin: 'http://127.0.0.1:3000',
  mediaKey: 'm'.repeat(32),
  pepper: 'p'.repeat(32),
  mediaDir: '.runtime/test-media',
  wechatSecret: '',
  allowDevAuth: false,
};
async function setup(t) {
  const ctx = await buildApp({ logger: false, config });
  t.after(() => ctx.app.close());
  let ip = 0;
  async function call(method, url, u, payload) {
    const r = await ctx.app.inject({
      method,
      url,
      payload,
      remoteAddress: '127.0.0.' + ++ip,
      headers: u ? { authorization: 'Bearer ' + u.token, 'idempotency-key': randomUUID() } : {},
    });
    return { ...r.json(), status: r.statusCode };
  }
  return { ...ctx, call };
}
test('account credentials verify the current password, rotate sessions and protect first setup', async (t) => {
  const { db, call } = await setup(t);
  const old = { username: 'security_cook', password: 'original-password-123' };
  const u = await call('POST', '/auth/register', null, old),
    otherSession = await call('POST', '/auth/password', null, old);
  const other = await call('POST', '/auth/register', null, {
    username: 'security_other',
    password: 'other-password-123',
  });
  const info = await call('GET', '/me/security', u);
  assert.equal(info.username, old.username);
  assert.equal(info.passwordSet, true);
  assert.equal(info.password_hash, undefined);
  assert.equal(
    (
      await call('POST', '/me/credentials', u, {
        username: 'new_security',
        currentPassword: 'wrong',
        newPassword: 'changed-password-123',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('POST', '/me/credentials', u, {
        username: 'security_other',
        currentPassword: old.password,
      })
    ).status,
    409,
  );
  assert.equal((await call('GET', '/me/security', u)).username, old.username);
  const updated = await call('POST', '/me/credentials', u, {
    username: 'new_security',
    currentPassword: old.password,
    newPassword: 'changed-password-123',
  });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.notEqual(updated.token, u.token);
  assert.equal((await call('GET', '/me', otherSession)).status, 401);
  assert.equal((await call('GET', '/me', u)).status, 401);
  assert.equal((await call('POST', '/auth/password', null, old)).status, 401);
  assert.equal(
    (
      await call('POST', '/auth/password', null, {
        username: 'new_security',
        password: 'changed-password-123',
      })
    ).status,
    200,
  );
  assert.equal((await call('GET', '/me/security', other)).username, 'security_other');
  const uid = randomUUID(),
    raw = token();
  await db.query('INSERT INTO users(id) VALUES($1)', [uid]);
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,now()+interval '1 day',now()-interval '1 hour')",
    [digest(raw), uid],
  );
  const first = { token: raw };
  const body = { username: 'first_setup', newPassword: 'first-password-123' };
  assert.equal((await call('POST', '/me/credentials', first, body)).status, 403);
  await db.query('UPDATE sessions SET created_at=now() WHERE user_id=$1', [uid]);
  assert.equal((await call('POST', '/me/credentials', first, body)).status, 200);
});
test('personal achievements aggregate by home, survive history pruning once and subtract dissolved homes', async (t) => {
  const { db, call } = await setup(t);
  const u = await call('POST', '/auth/register', null, {
    username: 'achievement_cook',
    password: 'achievement-password',
  });
  const outsider = await call('POST', '/auth/register', null, {
    username: 'achievement_other',
    password: 'achievement-password',
  });
  const date = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS date"))
    .rows[0].date;
  const fixtures = [];
  for (let i = 0; i < 2; i++) {
    const f = await call('POST', '/families', u, { name: '成就小家' + i }),
      base = '/families/' + f.id;
    const m = await call('GET', base + '/menu', u);
    const d = await call('POST', base + '/dishes', u, {
      name: '菜品' + i,
      collectionId: m.collections[0].id,
      minutes: 10,
      servings: 2,
    });
    const order = await call('POST', base + '/orders', u, {
      date,
      slot: '晚餐',
      items: [{ dishId: d.id, quantity: i + 2 }],
    });
    assert.equal(order.status, 200);
    const b = { date, slot: '晚餐', dishIds: [d.id] };
    assert.equal((await call('PUT', base + '/cooking-records', u, b)).status, 200);
    assert.equal((await call('PUT', base + '/cooking-records', u, b)).status, 200);
    assert.equal((await call('PUT', base + '/cooking-records', outsider, b)).status, 404);
    assert.equal(
      (
        await call(
          'GET',
          base + '/cooking-records?date=' + date + '&slot=' + encodeURIComponent('晚餐'),
          u,
        )
      ).dishIds.length,
      1,
    );
    fixtures.push({ f, d, base, order });
  }
  let stats = await call('GET', '/me/achievements', u);
  assert.equal(stats.cooked, 2);
  assert.equal(stats.ordered, 5);
  assert.equal(stats.families.length, 2);
  assert.equal((await call('GET', '/me/achievements', outsider)).cooked, 0);
  const f0 = fixtures[0];
  assert.equal(
    (
      await call('PUT', f0.base + '/cooking-records', u, {
        date: '2099-01-01',
        slot: '晚餐',
        dishIds: [f0.d.id],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('PUT', f0.base + '/cooking-records', u, {
        date,
        slot: '晚餐',
        dishIds: [fixtures[1].d.id],
      })
    ).status,
    400,
  );
  // Pending and rejected requests never become personal ordered achievements.
  const invite = await call('POST', f0.base + '/invitations', u, { role: 'eater' });
  await call('POST', '/invitations/' + invite.token + '/accept', outsider, {});
  const request = await call('POST', f0.base + '/orders', outsider, {
    date,
    slot: '午餐',
    items: [{ dishId: f0.d.id, quantity: 7 }],
  });
  assert.equal((await call('GET', '/me/achievements', outsider)).ordered, 0);
  await call('POST', f0.base + '/orders/' + request.id + '/reply', u, {
    decision: 'accept',
    reply: '',
  });
  assert.equal((await call('GET', '/me/achievements', outsider)).ordered, 7);
  assert.equal(
    (
      await call('PUT', f0.base + '/cooking-records', outsider, {
        date,
        slot: '午餐',
        dishIds: [f0.d.id],
      })
    ).status,
    403,
  );
  // Archive only totals when detailed history is removed. A second cleanup must not double count.
  await db.query(
    "UPDATE orders SET meal_date=(now() AT TIME ZONE 'Asia/Shanghai')::date-interval '4 months'",
  );
  await db.query(
    "UPDATE cooking_records SET meal_date=(now() AT TIME ZONE 'Asia/Shanghai')::date-interval '4 months'",
  );
  await pruneHistory(db);
  await pruneHistory(db);
  stats = await call('GET', '/me/achievements', u);
  assert.equal(stats.cooked, 2);
  assert.equal(stats.ordered, 5);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cooking_records')).rows[0].n, 0);
  const dissolved = await call('POST', fixtures[1].base + '/dissolution', u, {});
  assert.equal(dissolved.status, 200);
  stats = await call('GET', '/me/achievements', u);
  assert.equal(stats.cooked, 1);
  assert.equal(stats.ordered, 2);
  assert.equal(stats.families.length, 1);
  assert.equal(
    (
      await db.query('SELECT count(*)::int AS n FROM achievement_totals WHERE family_id=$1', [
        fixtures[1].f.id,
      ])
    ).rows[0].n,
    0,
  );
});
