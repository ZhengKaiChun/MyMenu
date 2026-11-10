import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url),
  config = require('../miniprogram/config/index.js');
if (config.mode !== 'production' || !config.apiBase.startsWith('https://'))
  throw Error(
    'Configure production HTTPS API before upload: node scripts/configure.mjs production https://your-api.example.com',
  );
const version = process.argv[2] || config.version;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw Error('Invalid version');
const cli = process.env.WECHAT_CLI || 'D:/小程序开发/微信web开发者工具/cli.bat';
const result = spawnSync(
  cli,
  ['upload', '--project', resolve('.'), '--version', version, '--desc', '给我饭 native ' + version],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(result.status ?? 1);
