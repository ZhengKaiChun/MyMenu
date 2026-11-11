const { seed, today } = require('./seed');
const key = require('../config/index').previewDatabaseKey || 'geiwofan.preview.database.v1';
const clone = (x) => JSON.parse(JSON.stringify(x));
function read() {
  const value = wx.getStorageSync(key);
  const db = value && value.schema === 1 ? clone(value) : seed();
  if (!db.inboxVersion) {
    for (const o of db.orders) {
      if (
        !db.notifications.some(
          (n) => n.user_id === o.user_id && n.entity_id === o.id && n.type === 'order.sent',
        )
      )
        notify(db, o.family_id, 'order.sent', o.id, '你点的菜已收到，点击查看回音', [o.user_id]);
    }
    db.inboxVersion = 1;
  }
  if (!db.uiVersion5) {
    for (const d of db.dishes) {
      d.featured = !!d.featured;
      d.spiceLevel = d.spiceLevel || 1;
    }
    for (const m of db.members) if (m.identity === '猪大二') m.identity = '猪大儿';
    for (const i of db.inventories) {
      if (['肉禽', '海鲜'].includes(i.category)) {
        i.meatType = i.category === '海鲜' ? '海鲜' : '其他';
        i.category = '肉类';
      } else i.meatType = i.meatType || '';
    }
    for (const c of [...db.collections].filter((c) => c.name === '招牌')) {
      const other = db.collections.find((x) => x.family_id === c.family_id && x.id !== c.id);
      for (const d of db.dishes.filter((d) => d.collectionId === c.id)) {
        d.featured = true;
        if (other) d.collectionId = other.id;
      }
      if (other) db.collections = db.collections.filter((x) => x.id !== c.id);
      else c.name = '家常菜';
    }
    for (const d of db.dishes) {
      const c = db.collections.find((c) => c.id === d.collectionId);
      d.meatType = d.meatType || (['肉类', '肉禽', '荤菜'].includes(c?.name) ? '其他' : '');
    }
    db.uiVersion5 = true;
  }
  for (const d of db.dishes) if (!d.collectionIds?.length) d.collectionIds = [d.collectionId];
  const cutoff = require('../lib/dates').bounds().min;
  db.orders = db.orders.filter((o) => o.meal_date >= cutoff);
  const orderIds = new Set(db.orders.map((o) => o.id)),
    lineIds = new Set(db.orders.flatMap((o) => o.items.map((l) => l.id)));
  db.changes = db.changes.filter((c) => lineIds.has(c.line_id));
  const changeIds = new Set(db.changes.map((c) => c.id));
  db.notifications = db.notifications.filter(
    (n) =>
      (n.created_at || '').slice(0, 10) >= cutoff &&
      (!n.type.startsWith('order.') || orderIds.has(n.entity_id)) &&
      (!n.type.startsWith('change.') || changeIds.has(n.entity_id)),
  );
  for (const key of Object.keys(db.checks)) if (key.slice(-10) < cutoff) delete db.checks[key];
  for (const [key, op] of Object.entries(db.operations)) {
    if (!op.at) op.at = Date.now();
    const body = JSON.parse(op.body || '{}');
    if (op.at < Date.now() - 7 * 86400000 || (typeof body.date === 'string' && body.date < cutoff))
      delete db.operations[key];
  }
  return db;
}
function save(db) {
  wx.setStorageSync(key, db);
}
function id() {
  return 'preview-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}
function fail(message, status = 400, code = 'PREVIEW_VALIDATION') {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  throw e;
}
function demand(value, message, status = 400, code) {
  if (!value) fail(message, status, code);
  return value;
}
function publicDish(d) {
  const { id, name, intro, coverId, minutes, servings, collectionId, version, sortOrder } = d;
  return {
    id,
    name,
    intro,
    coverId,
    minutes,
    servings,
    collectionId,
    collectionIds: d.collectionIds?.length ? d.collectionIds : [collectionId],
    version,
    sortOrder,
    featured: !!d.featured,
    spiceLevel: d.spiceLevel || 1,
    meatType: d.meatType || '',
  };
}
function membership(db, user, fid, cook = false) {
  const f = db.families.find((f) => f.id === fid && !f.deleted_at),
    m = db.members.find((m) => m.family_id === fid && m.user_id === user.id);
  demand(f && m, '这个小家已解散或你已离开', 404, 'FAMILY_NOT_FOUND');
  demand(!cook || m.role === 'cook', '这部分只有饲养员可以查看', 403, 'COOK_REQUIRED');
  return { ...f, ...m };
}
function homes(db, user) {
  return db.families
    .filter(
      (f) => !f.deleted_at && db.members.some((m) => m.family_id === f.id && m.user_id === user.id),
    )
    .map((f) => ({
      ...f,
      ...db.members.find((m) => m.family_id === f.id && m.user_id === user.id),
    }));
}
function notify(db, fid, type, entityId, body, recipients) {
  const ids =
    recipients ||
    db.members.filter((m) => m.family_id === fid && m.role === 'cook').map((m) => m.user_id);
  for (const uid of ids)
    db.notifications.unshift({
      id: id(),
      user_id: uid,
      family_id: fid,
      type,
      entity_id: entityId,
      body,
      created_at: new Date().toISOString(),
      read_at: null,
    });
}
function createHome(db, user, name) {
  demand(
    typeof name === 'string' && name.trim() && name.trim().length <= 40,
    '给小家起个40字以内的名字吧',
  );
  const f = { id: id(), name: name.trim(), owner_id: user.id, version: 1 };
  db.families.push(f);
  db.members.push({ family_id: f.id, user_id: user.id, role: 'cook', identity: '野生小猪' });
  db.collections.push({ id: id(), family_id: f.id, name: '拿手好菜', sort_order: 0 });
  return { ...f, role: 'cook', identity: '野生小猪' };
}
function findDish(db, fid, did) {
  return demand(
    db.dishes.find((d) => d.family_id === fid && d.id === did),
    '这道菜暂时不在菜单里',
    404,
  );
}
function meals(db, fid, date) {
  const groups = {};
  for (const o of db.orders.filter(
    (o) => o.family_id === fid && o.meal_date === date && o.status === 'accepted',
  ))
    for (const l of o.items) {
      const key = o.slot + ':' + l.dish_id;
      if (!groups[key])
        groups[key] = {
          dishId: l.dish_id,
          slot: o.slot,
          snapshot: publicDish(l.snapshot),
          quantity: 0,
          sources: [],
        };
      const u = db.users.find((u) => u.id === o.user_id),
        m = db.members.find((m) => m.family_id === fid && m.user_id === o.user_id);
      groups[key].quantity += l.quantity;
      groups[key].sources.push({
        id: l.id,
        quantity: l.quantity,
        userId: o.user_id,
        nickname: u.nickname,
        identity: m?.identity || '野生小猪',
        avatarId: u.avatarId,
        done: l.done,
      });
    }
  return { date, dishes: Object.values(groups) };
}
function eligible(db, user, fid) {
  return db.orders
    .filter(
      (o) =>
        o.family_id === fid &&
        o.user_id === user.id &&
        ['pending', 'accepted'].includes(o.status) &&
        o.meal_date >= today(),
    )
    .flatMap((o) =>
      o.items
        .filter((l) => !l.done)
        .map((l) => ({
          ...l,
          snapshot: publicDish(l.snapshot),
          meal_date: o.meal_date,
          slot: o.slot,
          status: o.status,
          version: o.version,
        })),
    );
}
module.exports = {
  read,
  save,
  id,
  clone,
  fail,
  demand,
  publicDish,
  membership,
  homes,
  notify,
  createHome,
  findDish,
  meals,
  eligible,
};
