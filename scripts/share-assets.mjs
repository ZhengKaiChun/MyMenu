import sharp from 'sharp';
const meta = await sharp('miniprogram/assets/pig-family.png').metadata();
const pig = await sharp('miniprogram/assets/pig-family.png')
  .extract({
    left: 0,
    top: 0,
    width: Math.floor(meta.width / 4),
    height: Math.floor(meta.height / 2),
  })
  .resize(68, 68)
  .png()
  .toBuffer();
for (const kind of ['invitation', 'invitation-cook', 'recipe']) {
  const recipe = kind === 'recipe';
  const title = recipe
    ? ['这几道拿手菜，', '想请你也尝尝']
    : ['邀请你', kind === 'invitation-cook' ? '一起打扫猪圈' : '加入我的猪圈'];
  const lines = Array.from(
    { length: 8 },
    (_, i) => `<path d="M36 ${63 + i * 37}L465 ${59 + i * 37}" stroke="#e9dcc2" stroke-width="1"/>`,
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400" viewBox="0 0 500 400"><rect width="500" height="400" fill="#fffcf6"/><rect x="25" y="21" width="453" height="365" rx="17" fill="#e4d6bf"/><rect x="20" y="16" width="453" height="365" rx="15" fill="#e9d2ac" stroke="#ba9465"/><path d="M32 42Q32 33 44 32L450 26Q461 26 461 39L467 355L37 360Z" fill="#fff9eb" stroke="#bfa078" stroke-width="1.5"/>${lines}<g font-family="Microsoft YaHei, sans-serif"><text x="52" y="69" font-size="12" fill="#ae885f">${recipe ? '把家的味道，寄给你' : '一封留给你的邀请'}</text><g transform="rotate(7 417 66)" fill="#b87958"><rect x="380" y="42" width="70" height="47" fill="#fffbf1" stroke="#c58b68" stroke-dasharray="3 2"/><text x="415" y="60" text-anchor="middle" font-size="10">给我饭</text><text x="415" y="75" text-anchor="middle" font-size="8">${recipe ? 'RECIPE MAIL' : 'INVITATION'}</text></g><text x="52" y="122" font-size="30" font-weight="700" fill="#885737">${title[0]}</text><text x="52" y="164" font-size="30" font-weight="700" fill="#885737">${title[1]}</text><text x="52" y="202" font-size="13" fill="#9b744f">${recipe ? '亲爱的饭搭子：' : '亲爱的小猪：'}</text><text x="52" y="232" font-size="13" fill="#a88258">${recipe ? '用料、做法，都在信里。' : '把一日三餐，过成我们的日常。'}</text><text x="52" y="258" font-size="13" fill="#a88258">${recipe ? '收进你的小家，好好吃饭。' : '饭桌上的位置，已经为你留好。'}</text>${recipe ? '' : '<text x="416" y="315" font-size="12" fill="#ad875e" text-anchor="end">等你回家吃饭 ♡</text>'}</g><image href="data:image/png;base64,${pig.toString('base64')}" x="50" y="275" width="68" height="68"/><path d="M21 349Q245 372 473 343L473 366Q473 381 458 381H35Q20 381 20 365Z" fill="#f0e1c2"/><path d="M21 349Q245 372 473 343" fill="none" stroke="#c6a374" stroke-width="1"/></svg>`;
  await sharp(Buffer.from(svg))
    .png()
    .toFile('miniprogram/assets/' + kind + '-share.png');
}
console.log('Original ruled-paper envelope covers rebuilt');
