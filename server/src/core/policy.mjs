import { demand } from './errors.mjs';
import { id, digest } from './security.mjs';
export async function member(db, user, family, role) {
  const r = await db.query(
    'SELECT m.*,f.owner_id,f.version,f.name FROM members m JOIN families f ON f.id=m.family_id WHERE m.user_id=$1 AND m.family_id=$2 AND f.deleted_at IS NULL',
    [user, family],
  );
  const m = r.rows[0];
  demand(m, 404, 'FAMILY_NOT_FOUND', '找不到这个小家');
  demand(!role || m.role === role, 403, 'ROLE_REQUIRED', '此操作需要饲养员权限');
  return m;
}
export async function familyLock(db, family) {
  await db.query('SELECT id FROM families WHERE id=$1 FOR UPDATE', [family]);
}
export async function audit(db, user, family, action, entity) {
  await db.query(
    'INSERT INTO audit_logs(id,actor_id,family_id,action,entity_id) VALUES($1,$2,$3,$4,$5)',
    [id(), user, family, action, entity || null],
  );
}
export async function notify(db, family, type, entity, body, users) {
  let list = users;
  if (!list)
    list = (
      await db.query("SELECT user_id FROM members WHERE family_id=$1 AND role='cook'", [family])
    ).rows.map((x) => x.user_id);
  for (const uid of new Set(list))
    await db.query(
      'INSERT INTO notifications(id,user_id,family_id,type,entity_id,body) VALUES($1,$2,$3,$4,$5,$6)',
      [id(), uid, family, type, entity, body],
    );
}
export async function atomic(db, user, key, operation, body, work) {
  demand(
    typeof key === 'string' && key.length >= 8 && key.length <= 100,
    400,
    'IDEMPOTENCY_KEY',
    '请刷新后重试',
  );
  const hash = digest(JSON.stringify(body));
  return db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO idempotency(user_id,key,operation,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [user, key, operation, hash],
    );
    const old = (
      await tx.query('SELECT * FROM idempotency WHERE user_id=$1 AND key=$2 FOR UPDATE', [
        user,
        key,
      ])
    ).rows[0];
    demand(
      old.operation === operation && old.request_hash === hash,
      409,
      'KEY_REUSED',
      '操作标识已被其他请求使用',
    );
    if (old.result) return old.result;
    const result = await work(tx);
    await tx.query('UPDATE idempotency SET result=$3 WHERE user_id=$1 AND key=$2', [
      user,
      key,
      JSON.stringify(result),
    ]);
    return result;
  });
}
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function dateAllowed(date) {
  const start = today(),
    end = new Date(start + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + 90);
  return date >= start && date <= end.toISOString().slice(0, 10);
}

export function isoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
