import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, relative, join } from 'node:path';
const root = resolve('miniprogram'),
  reports = [];
await mkdir('artifacts', { recursive: true });
async function walk(dir) {
  let out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(...(e.isDirectory() ? await walk(p) : [p]));
  }
  return out;
}
const config = JSON.parse(await readFile('project.config.json', 'utf8')),
  app = JSON.parse(await readFile('miniprogram/app.json', 'utf8'));
if (config.appid !== 'wx3ab03337b159fadd' || config.miniprogramRoot !== 'miniprogram/')
  throw Error('Project identity mismatch');
for (const page of app.pages)
  for (const ext of ['js', 'json', 'wxml', 'wxss']) await stat(join(root, page + '.' + ext));
const files = await walk(root);
for (const file of files) {
  if (file.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
  if (file.endsWith('.js')) {
    const out = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (out.status) throw Error(out.stderr);
  }
}
const forbidden = ['web-view', 'innerHTML', 'eval('];
for (const file of files.filter((f) => f.endsWith('.js') || f.endsWith('.wxml'))) {
  const source = await readFile(file, 'utf8');
  for (const value of forbidden)
    if (source.includes(value)) throw Error('Forbidden native pattern ' + value + ' in ' + file);
}
let total = 0;
for (const file of files) total += (await stat(file)).size;
if (total > 2 * 1024 * 1024) throw Error('Mini program main package exceeds 2 MiB');
reports.push({ name: 'native-structure', pages: app.pages.length, bytes: total, passed: true });
const compilerDir =
  process.env.WECHAT_COMPILER_DIR ||
  'D:/小程序开发/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
let available = true;
try {
  await stat(join(compilerDir, 'wcc.exe'));
} catch {
  available = false;
}
if (available) {
  const relativeFiles = (ext) =>
    files.filter((f) => f.endsWith(ext)).map((f) => relative(root, f).replaceAll('\\', '/'));
  for (const [name, args] of [
    [
      'wcc.exe',
      ['-o', resolve('artifacts/wxml.js'), ...relativeFiles('.wxml'), ...relativeFiles('.wxs')],
    ],
    [
      'wcsc.exe',
      [
        '-o',
        resolve('artifacts/wxss.js'),
        'app.wxss',
        ...relativeFiles('.wxss').filter((f) => f !== 'app.wxss'),
      ],
    ],
  ]) {
    const result = spawnSync(join(compilerDir, name), args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    });
    if (result.status !== 0) throw Error(name + ': ' + result.stderr + result.stdout);
    reports.push({ name, passed: true });
  }
} else
  reports.push({
    name: 'official-wechat-compiler',
    passed: null,
    note: 'Not installed on this host; structural checks still passed',
  });
await writeFile(
  'artifacts/native-check.json',
  JSON.stringify({ at: new Date().toISOString(), reports }, null, 2),
);
console.log(JSON.stringify(reports, null, 2));
