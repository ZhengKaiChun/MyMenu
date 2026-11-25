import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildApp } from '../src/app.mjs';
test('uploads are decoded, re-encoded and signed; malicious images and foreign access fail', async (t) => {
  let dir = resolve('.runtime/test-media');
  await mkdir(dir, { recursive: true });
  let { app, db } = await buildApp({
    config: {
      production: false,
      database: {},
      origin: 'http://127.0.0.1:3000',
      mediaKey: 'm'.repeat(32),
      pepper: 'p'.repeat(32),
      mediaDir: dir,
      wechatSecret: '',
      allowDevAuth: false,
    },
    logger: false,
  });
  t.after(() => app.close());
  const register = async (name) =>
      (
        await app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: { username: name, password: 'image-test-password' },
        })
      ).json(),
    a = await register('image_owner'),
    b = await register('image_outside');
  const boundary = 'native-upload-test';
  async function upload(bytes, mime) {
    let payload = Buffer.concat([
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: ' +
          mime +
          '\r\n\r\n',
      ),
      bytes,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    return app.inject({
      method: 'POST',
      url: '/media',
      headers: {
        authorization: 'Bearer ' + a.token,
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
      payload,
    });
  }
  let bad = await upload(Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/svg+xml');
  assert.equal(bad.statusCode, 400);
  bad = await upload(Buffer.from('<svg>not a PNG</svg>'), 'image/png');
  assert.equal(bad.statusCode, 400);
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#fac' } })
      .png()
      .toBuffer(),
    out = await upload(png, 'image/png');
  assert.equal(out.statusCode, 200, out.body);
  let mid = out.json().id,
    stored = (await db.query('SELECT * FROM media WHERE id=$1', [mid])).rows[0];
  t.after(() => unlink(join(dir, stored.filename)));
  assert.equal(stored.mime, 'image/jpeg');
  const encoded = await readFile(join(dir, stored.filename));
  assert.equal(encoded.subarray(0, 3).toString('hex'), 'ffd8ff');
  let foreign = await app.inject({
    method: 'POST',
    url: '/media/' + mid + '/url',
    headers: { authorization: 'Bearer ' + b.token },
    payload: {},
  });
  assert.equal(foreign.statusCode, 404);
  let link = await app.inject({
    method: 'POST',
    url: '/media/' + mid + '/url',
    headers: { authorization: 'Bearer ' + a.token },
    payload: {},
  });
  assert.equal(link.statusCode, 200);
  const url = new URL(link.json().url);
  let image = await app.inject({ url: url.pathname + url.search });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.equal(image.rawPayload.subarray(0, 3).toString('hex'), 'ffd8ff');
  const legacyId = randomUUID();
  const legacyName = legacyId + '.webp';
  const legacyJpegName = legacyId + '.jpg';
  await writeFile(join(dir, legacyName), await sharp(png).webp().toBuffer());
  const ownerId = (await db.query('SELECT id FROM users WHERE username=$1', ['image_owner']))
    .rows[0].id;
  await db.query('INSERT INTO media(id,owner_id,filename,mime,size) VALUES($1,$2,$3,$4,$5)', [
    legacyId,
    ownerId,
    legacyName,
    'image/webp',
    (await readFile(join(dir, legacyName))).length,
  ]);
  t.after(async () => {
    await unlink(join(dir, legacyName));
    await unlink(join(dir, legacyJpegName));
  });
  const legacyLink = await app.inject({
    method: 'POST',
    url: '/media/' + legacyId + '/url',
    headers: { authorization: 'Bearer ' + a.token },
    payload: {},
  });
  assert.equal(legacyLink.statusCode, 200);
  const legacyUrl = new URL(legacyLink.json().url);
  const legacyImage = await app.inject({ url: legacyUrl.pathname + legacyUrl.search });
  assert.equal(legacyImage.statusCode, 200);
  assert.equal(legacyImage.headers['content-type'], 'image/jpeg');
  assert.equal(legacyImage.rawPayload.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.equal(
    (await readFile(join(dir, legacyJpegName))).subarray(0, 3).toString('hex'),
    'ffd8ff',
  );
  url.searchParams.set('signature', '0'.repeat(64));
  assert.equal((await app.inject({ url: url.pathname + url.search })).statusCode, 403);
  let conflict = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'image_owner', password: 'image-test-password' },
  });
  assert.equal(conflict.statusCode, 409);
  assert.ok(!/constraint|users|password_hash/i.test(conflict.json().error.message));
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/families',
        headers: { authorization: 'Bearer ' + a.token },
        payload: { name: 'x', role: 'cook' },
      })
    ).statusCode,
    400,
  );
});

test('meal snapshot cover remains visible to family members after recipe photo changes', async (t) => {
  const { app, db } = await buildApp({
    config: {
      production: false,
      database: {},
      origin: 'http://127.0.0.1:3000',
      mediaKey: 'm'.repeat(32),
      pepper: 'p'.repeat(32),
      mediaDir: '.runtime/test-media',
      wechatSecret: '',
      allowDevAuth: false,
    },
    logger: false,
  });
  t.after(() => app.close());
  const register = async (username) => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username, password: 'snapshot-test-password' },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const cook = await register('snapshot_cook');
  const eater = await register('snapshot_eater');
  const outsider = await register('snapshot_outsider');
  const observer = await register('snapshot_observer');
  const userId = async (username) =>
    (await db.query('SELECT id FROM users WHERE username=$1', [username])).rows[0].id;
  const cookId = await userId('snapshot_cook');
  const eaterId = await userId('snapshot_eater');
  const observerId = await userId('snapshot_observer');
  const familyId = randomUUID();
  const collectionId = randomUUID();
  const dishId = randomUUID();
  const orderId = randomUUID();
  const oldCoverId = randomUUID();
  const currentCoverId = randomUUID();
  await db.query('INSERT INTO families(id,name,owner_id) VALUES($1,$2,$3)', [
    familyId,
    '测试小家',
    cookId,
  ]);
  await db.query('INSERT INTO members(family_id,user_id,role) VALUES($1,$2,$3),($1,$4,$5)', [
    familyId,
    cookId,
    'cook',
    eaterId,
    'eater',
  ]);
  await db.query('INSERT INTO members(family_id,user_id,role) VALUES($1,$2,$3)', [
    familyId,
    observerId,
    'eater',
  ]);
  await db.query('INSERT INTO collections(id,family_id,name) VALUES($1,$2,$3)', [
    collectionId,
    familyId,
    '拿手菜',
  ]);
  await db.query(
    'INSERT INTO dishes(id,family_id,collection_id,name,cover_id) VALUES($1,$2,$3,$4,$5)',
    [dishId, familyId, collectionId, '封面已更新的菜', currentCoverId],
  );
  await db.query('INSERT INTO recipes(dish_id,ingredients,steps) VALUES($1,$2,$3)', [
    dishId,
    '[]',
    '[]',
  ]);
  await db.query('INSERT INTO media(id,owner_id,filename,mime,size) VALUES($1,$2,$3,$4,$5)', [
    oldCoverId,
    cookId,
    oldCoverId + '.jpg',
    'image/jpeg',
    123,
  ]);
  await db.query(
    'INSERT INTO orders(id,family_id,user_id,meal_date,slot,status) VALUES($1,$2,$3,$4,$5,$6)',
    [orderId, familyId, eaterId, '2026-11-25', '晚餐', 'accepted'],
  );
  await db.query(
    'INSERT INTO order_lines(id,order_id,dish_id,quantity,snapshot) VALUES($1,$2,$3,$4,$5)',
    [
      randomUUID(),
      orderId,
      dishId,
      1,
      JSON.stringify({ id: dishId, name: '封面已更新的菜', coverId: oldCoverId }),
    ],
  );
  const signed = async (token) =>
    app.inject({
      method: 'POST',
      url: '/media/' + oldCoverId + '/url',
      headers: { authorization: 'Bearer ' + token },
      payload: {},
    });
  assert.equal((await signed(eater.token)).statusCode, 200);
  assert.equal((await signed(cook.token)).statusCode, 200);
  assert.equal((await signed(observer.token)).statusCode, 200);
  assert.equal((await signed(outsider.token)).statusCode, 404);
  await db.query("UPDATE orders SET status='pending' WHERE id=$1", [orderId]);
  assert.equal((await signed(eater.token)).statusCode, 200);
  assert.equal((await signed(cook.token)).statusCode, 200);
  assert.equal((await signed(observer.token)).statusCode, 404);
  await db.query("UPDATE orders SET status='rejected' WHERE id=$1", [orderId]);
  assert.equal((await signed(eater.token)).statusCode, 200);
  assert.equal((await signed(cook.token)).statusCode, 200);
  assert.equal((await signed(observer.token)).statusCode, 404);
});
