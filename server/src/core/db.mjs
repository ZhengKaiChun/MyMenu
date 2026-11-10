import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile, readdir, mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest } from './security.mjs';
export async function createDatabase(config = {}) {
  if (config.url) {
    const pool = new pg.Pool({
      connectionString: config.url,
      max: 10,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    });
    return {
      query: (s, p = []) => pool.query(s, p),
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          let out = await fn({ query: (s, p = []) => c.query(s, p) });
          await c.query('COMMIT');
          return out;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }
  let lock = null;
  if (config.directory) {
    const directory = resolve(config.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    lock = directory + '.menu.lock';
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch {
      const pid = Number(await readFile(lock, 'utf8'));
      let live = false;
      try {
        process.kill(pid, 0);
        live = true;
      } catch {
        /* Missing PID means the previous local process stopped. */
      }
      if (live)
        throw new Error(
          'Local database is in use; stop the existing server before seeding or backing up',
        );
      await unlink(lock);
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    }
  }
  const db = new PGlite(config.directory);
  await db.waitReady;
  return {
    query: (s, p = []) => db.query(s, p),
    transaction: (fn) => db.transaction((t) => fn({ query: (s, p = []) => t.query(s, p) })),
    close: async () => {
      await db.close();
      if (lock) await unlink(lock);
    },
  };
}
export async function migrate(db) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const folder = new URL('../../migrations/', import.meta.url);
  const files = (await readdir(folder)).filter((n) => /^\d+_.*\.sql$/.test(n)).sort();
  for (const file of files) {
    const version = Number(file.split('_')[0]),
      sql = (await readFile(new URL(file, folder), 'utf8')).replaceAll('\r\n', '\n'),
      checksum = digest(sql);
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(73402912)');
      const old = (
        await tx.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version])
      ).rows[0];
      if (old) {
        if (old.checksum !== checksum) {
          // Accept only the previous Windows newline representation of identical SQL.
          if (old.checksum !== digest(sql.replaceAll('\n', '\r\n')))
            throw new Error('Migration changed after application: ' + file);
          await tx.query('UPDATE schema_migrations SET checksum=$2 WHERE version=$1', [
            version,
            checksum,
          ]);
        }
        return;
      }
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
        version,
        checksum,
      ]);
    });
  }
}
