import { mkdir, readFile, cp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const stamp = new Date().toISOString().replaceAll(':', '-'),
  out = resolve('.runtime/backups', stamp);
await mkdir(out, { recursive: true, mode: 0o700 });
if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL),
    env = {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: u.pathname.slice(1),
    };
  const result = spawnSync('pg_dump', ['-Fc', '-f', join(out, 'database.dump')], {
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw Error('Install PostgreSQL client tools and retry backup');
} else {
  const dir = resolve(process.env.DATABASE_DIR || '.runtime/postgres');
  let lock;
  try {
    lock = Number(await readFile(join(dir, '.menu.lock'), 'utf8'));
  } catch {
    /* No local server lock. */
  }
  if (lock) {
    try {
      process.kill(lock, 0);
      throw Error('Stop the local API before taking its file backup');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
  await cp(dir, join(out, 'postgres'), { recursive: true });
}
try {
  await cp(resolve(process.env.MEDIA_DIR || '.runtime/media'), join(out, 'media'), {
    recursive: true,
  });
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
await writeFile(
  join(out, 'README.txt'),
  'Private database and image backup. Do not commit or share this directory. Restore only with the API stopped.\n',
);
console.log(out);
