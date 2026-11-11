import sharp from 'sharp';
const chili = (filled) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M44 18C45 9 40 7 35 8" fill="none" stroke="${filled ? '#7c8e57' : '#b8ab91'}" stroke-width="5" stroke-linecap="round"/><path d="M42 18C57 26 47 48 12 56C26 45 26 35 27 26C28 18 35 15 42 18Z" fill="${filled ? '#c96249' : 'none'}" stroke="${filled ? '#a74d3d' : '#c8bea8'}" stroke-width="3.5" stroke-linejoin="round"/><path d="M34 24Q42 25 40 33" fill="none" stroke="${filled ? '#eaa28c' : '#e1d7c6'}" stroke-width="3" stroke-linecap="round"/></svg>`;
const star =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 5L40 23L60 25L45 39L49 59L32 49L14 59L18 39L3 25L24 23Z" fill="#e8bc53" stroke="#c3973d" stroke-width="3" stroke-linejoin="round"/></svg>';
for (const [name, svg] of [
  ['chili', chili(true)],
  ['chili-outline', chili(false)],
  ['star', star],
])
  await sharp(Buffer.from(svg))
    .png()
    .toFile('miniprogram/assets/icons/' + name + '.png');
