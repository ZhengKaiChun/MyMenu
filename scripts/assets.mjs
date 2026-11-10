import sharp from 'sharp';
import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
const source =
    process.env.DESIGN_ASSETS ||
    'D:/codex/projects/给我饭/界面设计_v12_菜谱分享与哭哭小猪_20261110/assets',
  out = 'miniprogram/assets';
await mkdir(out + '/icons', { recursive: true });
for (const name of ['pig-family', 'pig-kitchen', 'pigs-crying'])
  await sharp(join(source, name + '.png'))
    .resize({ width: name === 'pig-kitchen' ? 640 : 960, withoutEnlargement: true })
    .png({ palette: true, colours: 96, compressionLevel: 9 })
    .toFile(out + '/' + name + '.png');
const meta = await sharp(join(source, 'food-grid.png')).metadata();
for (let i = 0; i < 4; i++) {
  let left = Math.floor(((i % 2) * meta.width) / 2),
    top = Math.floor((Math.floor(i / 2) * meta.height) / 2),
    width = Math.floor(meta.width / 2),
    height = Math.floor(meta.height / 2);
  await sharp(join(source, 'food-grid.png'))
    .extract({ left, top, width, height })
    .resize(360, 360, { fit: 'cover' })
    .jpeg({ quality: 82 })
    .toFile(out + '/food-' + i + '.jpg');
}
const names = [
  'bowl',
  'pot',
  'book',
  'basket',
  'home',
  'calendar',
  'envelope',
  'search',
  'bell',
  'heart',
  'check',
  'plus',
  'clock',
  'edit',
  'people',
  'share',
  'chat',
  'info',
  'wifi',
  'key',
  'user',
  'settings',
  'lock',
  'phone',
  'tomato',
  'egg',
  'milk',
  'leaf',
  'utensils',
  'door',
  'trash',
  'image',
];
for (const n of names)
  await copyFile(join(source, 'icons', n + '.svg'), out + '/icons/' + n + '.svg');
console.log('Native image assets ready');

for (const n of names)
  await sharp(join(source, 'icons', n + '.svg'))
    .resize(64, 64)
    .png()
    .toFile(out + '/icons/' + n + '.png');
await sharp({ create: { width: 360, height: 360, channels: 4, background: '#f3e8d4' } })
  .composite([
    {
      input: await sharp(join(source, 'icons/bowl.svg')).resize(145, 145).png().toBuffer(),
      gravity: 'centre',
    },
  ])
  .png()
  .toFile(out + '/food-placeholder.png');
