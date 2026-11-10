import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrate } from '../src/core/db.mjs';
import { digest } from '../src/core/security.mjs';
test('local independent database persists across restarts and prevents competing processes', async () => {
  const root = resolve('.runtime/tests'),
    directory = resolve(root, 'db-' + randomUUID());
  assert.ok(directory.startsWith(root + sep));
  await mkdir(root, { recursive: true });
  let db;
  try {
    db = await createDatabase({ directory });
    await migrate(db);
    const uid = randomUUID();
    await db.query('INSERT INTO users(id,nickname) VALUES($1,$2)', [uid, '重启后还在的小猪']);
    await assert.rejects(() => createDatabase({ directory }), /in use/);
    await db.close();
    db = null;
    db = await createDatabase({ directory });
    await migrate(db);
    const user = (await db.query('SELECT nickname FROM users WHERE id=$1', [uid])).rows[0];
    assert.equal(user.nickname, '重启后还在的小猪');
    const sql = (
      await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8')
    ).replaceAll('\r\n', '\n');
    await db.query('UPDATE schema_migrations SET checksum=$1 WHERE version=1', [
      digest(sql.replaceAll('\n', '\r\n')),
    ]);
    await migrate(db);
    assert.equal(
      (await db.query('SELECT checksum FROM schema_migrations WHERE version=1')).rows[0].checksum,
      digest(sql),
    );
    await db.query("UPDATE schema_migrations SET checksum='invalid' WHERE version=1");
    await assert.rejects(() => migrate(db), /Migration changed/);
  } finally {
    if (db) await db.close();
    assert.ok(directory.startsWith(root + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
