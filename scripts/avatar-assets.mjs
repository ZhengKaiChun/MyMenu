import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
const source = 'miniprogram/assets/pig-family.png';
const { width, height } = await sharp(source).metadata();
await mkdir('miniprogram/assets/avatars', { recursive: true });
for (let i = 0; i < 8; i++) {
  const left = Math.round(((i % 4) * width) / 4),
    top = Math.round((Math.floor(i / 4) * height) / 2);
  const right = Math.round((((i % 4) + 1) * width) / 4),
    bottom = Math.round(((Math.floor(i / 4) + 1) * height) / 2);
  await sharp(source)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(200, 200, { fit: 'contain' })
    .png()
    .toFile('miniprogram/assets/avatars/pig-' + i + '.png');
}
