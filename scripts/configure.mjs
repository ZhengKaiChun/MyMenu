import { writeFile } from 'node:fs/promises';
const [mode = 'development', base = 'http://127.0.0.1:3000'] = process.argv.slice(2);
if (!['preview', 'development', 'production'].includes(mode))
  throw Error('Choose preview, development or production');
const url = new URL(base);
if (
  mode === 'production' &&
  (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname))
)
  throw Error('Production requires your public HTTPS API domain');
if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
  throw Error('Use an origin URL without credentials or path');
await writeFile(
  'miniprogram/config/index.js',
  'module.exports = ' +
    JSON.stringify(
      { mode, apiBase: url.origin, version: '0.2.0-rc.7', appId: 'wx3ab03337b159fadd' },
      null,
      2,
    ) +
    ';\n',
);
console.log('Native API configured: ' + mode + ' ' + url.origin);
