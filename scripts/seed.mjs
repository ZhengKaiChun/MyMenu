import { buildApp } from '../server/src/app.mjs';
import { configFromEnv } from '../server/src/config.mjs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
const config = configFromEnv();
if (config.production) throw Error('Seeding is development-only');
try {
  await stat('.runtime/demo-accounts.json');
  console.log('Demo accounts already exist: .runtime/demo-accounts.json');
  process.exit(0);
} catch {
  /* First local setup. */
}
const { app, db } = await buildApp({ config, logger: false });
try {
  async function call(method, url, token, payload) {
    const r = await app.inject({
      method,
      url,
      payload,
      headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        'idempotency-key': randomUUID(),
      },
    });
    if (r.statusCode !== 200) throw Error('Seed request failed: ' + r.statusCode + ' ' + r.body);
    return r.json();
  }
  let accounts = [];
  for (const username of ['local_chef', 'local_pig']) {
    const password = randomBytes(16).toString('base64url'),
      out = await call('POST', '/auth/register', null, { username, password });
    accounts.push({ username, password, ...out });
  }
  let chef = accounts[0],
    pig = accounts[1];
  await call('PATCH', '/me', chef.token, { nickname: '桃桃' });
  await call('PATCH', '/me', pig.token, { nickname: '阿拱' });
  let family = await call('POST', '/families', chef.token, { name: '两只小猪的家' });
  let base = '/families/' + family.id;
  let invitation = await call('POST', base + '/invitations', chef.token, { role: 'eater' });
  await call('POST', '/invitations/' + invitation.token + '/accept', pig.token, {});
  await call('PATCH', base + '/identity', chef.token, { identity: '猪妈妈' });
  await call('PATCH', base + '/identity', pig.token, { identity: '猪爸爸' });
  let menu = await call('GET', base + '/menu', chef.token);
  const data = [
    [
      '番茄炒蛋',
      '酸酸甜甜，家的味道',
      [
        { name: '番茄', quantity: 2, unit: '个' },
        { name: '鸡蛋', quantity: 3, unit: '个' },
        { name: '盐', quantity: 2, unit: 'g' },
      ],
      15,
    ],
    [
      '蜜汁鸡翅',
      '甜蜜挂汁，忍不住再来一只',
      [
        { name: '鸡翅', quantity: 8, unit: '只' },
        { name: '蜂蜜', quantity: 15, unit: 'g' },
        { name: '生抽', quantity: 15, unit: 'ml' },
      ],
      30,
    ],
    [
      '蒜香西兰花',
      '清清爽爽，刚好配一桌',
      [
        { name: '西兰花', quantity: 1, unit: '颗' },
        { name: '大蒜', quantity: 3, unit: '瓣' },
        { name: '盐', quantity: 2, unit: 'g' },
      ],
      10,
    ],
    [
      '番茄蛋汤',
      '一碗热乎乎的小幸福',
      [
        { name: '番茄', quantity: 1, unit: '个' },
        { name: '鸡蛋', quantity: 1, unit: '个' },
        { name: '盐', quantity: 1, unit: 'g' },
      ],
      10,
    ],
  ];
  let dishIds = [];
  await mkdir(config.mediaDir, { recursive: true });
  for (let i = 0; i < data.length; i++) {
    const mid = randomUUID(),
      filename = mid + '.webp',
      bytes = await sharp(await readFile('miniprogram/assets/food-' + i + '.jpg'))
        .webp({ quality: 85 })
        .toBuffer();
    await writeFile(join(config.mediaDir, filename), bytes);
    await db.query('INSERT INTO media(id,owner_id,filename,mime,size) VALUES($1,$2,$3,$4,$5)', [
      mid,
      chef.user.id,
      filename,
      'image/webp',
      bytes.length,
    ]);
    const [name, intro, ingredients, minutes] = data[i];
    let out = await call('POST', base + '/dishes', chef.token, {
      name,
      intro,
      collectionId: menu.collections[0].id,
      coverId: mid,
      minutes,
      servings: 2,
      ingredients,
      steps: [
        { text: '洗净食材，按需要切好，准备调料。' },
        { text: '热锅放油，按食材顺序下锅，翻炒或焖煮至熟。' },
        { text: '调味后出锅，盛盘并喊小猪一起吃饭。' },
      ],
    });
    dishIds.push(out.id);
  }
  for (const item of [
    { name: '番茄', quantity: 3, unit: '个', category: '蔬菜' },
    { name: '鸡蛋', quantity: 6, unit: '个', category: '蛋奶' },
    { name: '西兰花', quantity: 1, unit: '颗', category: '蔬菜' },
  ])
    await call('POST', base + '/inventory', chef.token, item);
  let date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  await call('POST', base + '/orders', chef.token, {
    date,
    slot: '晚餐',
    items: [{ dishId: dishIds[2], quantity: 1 }],
  });
  await call('POST', base + '/orders', pig.token, {
    date,
    slot: '晚餐',
    note: '今天想吃甜甜的鸡翅，少放一点盐～',
    items: [
      { dishId: dishIds[0], quantity: 1 },
      { dishId: dishIds[1], quantity: 1 },
    ],
  });
  await mkdir('.runtime', { recursive: true });
  await writeFile(
    '.runtime/demo-accounts.json',
    JSON.stringify(
      {
        note: 'Private local testing credentials; never upload or commit.',
        family: family.id,
        accounts: accounts.map((a) => ({
          username: a.username,
          password: a.password,
          role: a === chef ? 'cook' : 'eater',
        })),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log('Design test data ready. Login credentials: .runtime/demo-accounts.json');
} finally {
  await app.close();
}
