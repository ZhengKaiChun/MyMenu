import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readFile, unlink, mkdir } from 'node:fs/promises';
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
  assert.equal(stored.mime, 'image/webp');
  const encoded = await readFile(join(dir, stored.filename));
  assert.equal(encoded.subarray(0, 4).toString(), 'RIFF');
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
  assert.equal(image.headers['content-type'], 'image/webp');
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
