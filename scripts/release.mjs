import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw Error('Commit the working tree before making a release');
const pkg = JSON.parse(await readFile('package.json', 'utf8')),
  sha = git('rev-parse', 'HEAD'),
  files = git('ls-files', '-z').split('\0').filter(Boolean),
  checksums = {};
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw Error('Release needs a stable semantic version');
if (git('rev-parse', 'v' + pkg.version + '^{commit}') !== sha)
  throw Error('Tag v' + pkg.version + ' must point to HEAD');
for (const file of files)
  checksums[file] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
await mkdir('artifacts', { recursive: true });
const path = 'artifacts/menu-v' + pkg.version + '-' + sha.slice(0, 8) + '.zip';
git('archive', '--format=zip', '--output=' + path, 'HEAD');
git('bundle', 'create', 'artifacts/menu-history.bundle', '--all');
await writeFile(
  'artifacts/release-manifest.json',
  JSON.stringify(
    {
      version: pkg.version,
      commit: sha,
      node: process.version,
      at: new Date().toISOString(),
      archive: path,
      archiveSha256: createHash('sha256').update(await readFile(path)).digest('hex'),
      historySha256: createHash('sha256').update(await readFile('artifacts/menu-history.bundle')).digest('hex'),
      files: checksums,
    },
    null,
    2,
  ),
);
console.log(path + '\n' + sha);
