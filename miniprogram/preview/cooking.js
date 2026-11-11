const S = require('./store'),
  dates = require('../lib/dates');
const match = (c, fid, date, slot, dishId) =>
  c.familyId === fid && c.date === date && c.slot === slot && c.dishId === dishId;
function queue(db) {
  db.cookingReminders = db.cookingReminders || [];
  for (const o of db.orders) {
    if (
      o.status !== 'accepted' ||
      o.meal_date >= dates.today() ||
      o.meal_date < dates.bounds().min ||
      !db.families.some((f) => f.id === o.family_id && !f.deleted_at)
    )
      continue;
    for (const l of o.items) {
      if (
        db.cookingRecords.some((c) => match(c, o.family_id, o.meal_date, o.slot, l.dish_id)) ||
        db.cookingReminders.some((c) => match(c, o.family_id, o.meal_date, o.slot, l.dish_id))
      )
        continue;
      const r = {
        id: S.id(),
        familyId: o.family_id,
        date: o.meal_date,
        slot: o.slot,
        dishId: l.dish_id,
      };
      db.cookingReminders.push(r);
      S.notify(
        db,
        o.family_id,
        'cooking.reminder',
        r.id,
        r.date + ' · ' + r.slot + '的' + l.snapshot.name + '，是你做的吗？',
      );
    }
  }
}
function claim(db, user, fid, b) {
  S.membership(db, user, fid, true);
  S.demand(
    typeof b.done === 'boolean' && b.date >= dates.bounds().min && b.date <= dates.today(),
    '只能确认今天或最近三个月的已过日期',
  );
  S.demand(b.done || b.date === dates.today(), '已过日期不能取消认领', 409);
  S.demand(
    S.meals(db, fid, b.date).dishes.some((d) => d.dishId === b.dishId && d.slot === b.slot),
    '这道菜不在该餐最终菜单中',
    404,
  );
  const own = db.cookingRecords.find((c) => match(c, fid, b.date, b.slot, b.dishId));
  S.demand(
    !own || own.userId === user.id,
    '已有其他饲养员确认，这条提醒已失效',
    409,
    'COOK_CLAIMED',
  );
  if (b.done && !own)
    db.cookingRecords.push({
      familyId: fid,
      userId: user.id,
      date: b.date,
      slot: b.slot,
      dishId: b.dishId,
    });
  if (!b.done)
    db.cookingRecords = db.cookingRecords.filter((c) => !match(c, fid, b.date, b.slot, b.dishId));
  if (b.done) {
    const rem = db.cookingReminders.find((c) => match(c, fid, b.date, b.slot, b.dishId));
    if (rem)
      for (const n of db.notifications)
        if (n.type === 'cooking.reminder' && n.entity_id === rem.id) {
          n.invalidated_at = new Date().toISOString();
          n.read_at = n.read_at || n.invalidated_at;
        }
  }
  for (const o of db.orders)
    if (
      o.family_id === fid &&
      o.meal_date === b.date &&
      o.slot === b.slot &&
      o.status === 'accepted'
    )
      for (const l of o.items) if (l.dish_id === b.dishId) l.done = b.done;
  return { ok: true, done: b.done };
}
function detail(db, user, fid, id) {
  S.membership(db, user, fid, true);
  const r = S.demand(
      db.cookingReminders.find((r) => r.id === id && r.familyId === fid),
      '这条提醒已失效',
      410,
    ),
    d = S.demand(
      S.meals(db, fid, r.date).dishes.find((d) => d.dishId === r.dishId && d.slot === r.slot),
      '菜单已不存在',
      410,
    );
  const c = db.cookingRecords.find((c) => match(c, fid, r.date, r.slot, r.dishId)),
    u = c && db.users.find((u) => u.id === c.userId),
    m = c && db.members.find((m) => m.family_id === fid && m.user_id === c.userId);
  return {
    ...r,
    name: d.snapshot.name,
    coverId: d.snapshot.coverId,
    cooker: c
      ? { userId: c.userId, nickname: u.nickname, identity: m?.identity || '野生小猪' }
      : null,
    claimable: !c,
  };
}
module.exports = { queue, claim, detail };
