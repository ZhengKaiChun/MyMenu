const S = require('./store'),
  hash = require('./hash');
function security(user) {
  return { username: user.username || '', passwordSet: !!user.passwordHash, phoneBound: false };
}
function credentials(db, user, body, currentToken) {
  S.demand(/^[A-Za-z0-9_]{4,32}$/.test(body.username), '账号需要4–32位字母、数字或下划线');
  const name = body.username.toLowerCase();
  S.demand(
    !db.users.some((u) => u.id !== user.id && u.username?.toLowerCase() === name),
    '这个账号已经存在',
    409,
  );
  if (user.passwordHash)
    S.demand(
      hash(user.salt + (body.currentPassword || '')) === user.passwordHash,
      '当前密码不正确',
      403,
    );
  else
    S.demand(
      (db.sessionTimes[currentToken] || 0) > Date.now() - 300000,
      '请先退出并重新登录，再设置账号密码',
      403,
    );
  S.demand(user.passwordHash || body.newPassword, '首次设置需要填写密码');
  S.demand(body.newPassword || name !== user.username, '账号没有变化');
  if (body.newPassword) {
    S.demand(
      typeof body.newPassword === 'string' &&
        body.newPassword.length >= 10 &&
        body.newPassword.length <= 128,
      '密码需要10–128位',
    );
    user.salt = S.id();
    user.passwordHash = hash(user.salt + body.newPassword);
  }
  user.username = name;
  for (const key of Object.keys(db.sessions))
    if (db.sessions[key] === user.id) {
      delete db.sessions[key];
      delete db.sessionTimes[key];
    }
  const token = S.id();
  db.sessions[token] = user.id;
  db.sessionTimes[token] = Date.now();
  return { token, user: { id: user.id, nickname: user.nickname, avatarId: user.avatarId } };
}
function archive(db, cutoff) {
  db.cookingRecords = db.cookingRecords || [];
  db.achievementTotals = db.achievementTotals || {};
  const add = (uid, fid, field, n) => {
    if (
      !db.families.some((f) => f.id === fid && !f.deleted_at) ||
      !db.users.some((u) => u.id === uid && !u.deleted_at)
    )
      return;
    const key = uid + ':' + fid,
      row = db.achievementTotals[key] || { userId: uid, familyId: fid, cooked: 0, ordered: 0 };
    row[field] += n;
    db.achievementTotals[key] = row;
  };
  for (const o of db.orders)
    if (
      o.meal_date < cutoff &&
      o.status === 'accepted' &&
      o.meal_date < require('../lib/dates').today()
    )
      add(
        o.user_id,
        o.family_id,
        'ordered',
        o.items.reduce((n, l) => n + l.quantity, 0),
      );
  for (const c of db.cookingRecords) if (c.date < cutoff) add(c.userId, c.familyId, 'cooked', 1);
  db.cookingRecords = db.cookingRecords.filter((c) => c.date >= cutoff);
}
function achievements(db, user) {
  const families = S.homes(db, user).map((f) => {
    const bank = db.achievementTotals[user.id + ':' + f.id] || { cooked: 0, ordered: 0 };
    return {
      id: f.id,
      name: f.name,
      role: f.role,
      cooked:
        bank.cooked +
        db.cookingRecords.filter(
          (c) =>
            c.userId === user.id && c.familyId === f.id && c.date < require('../lib/dates').today(),
        ).length,
      ordered:
        bank.ordered +
        db.orders
          .filter(
            (o) =>
              o.user_id === user.id &&
              o.family_id === f.id &&
              o.status === 'accepted' &&
              o.meal_date < require('../lib/dates').today(),
          )
          .reduce((n, o) => n + o.items.reduce((n, l) => n + l.quantity, 0), 0),
    };
  });
  return {
    families,
    cooked: families.reduce((n, f) => n + f.cooked, 0),
    ordered: families.reduce((n, f) => n + f.ordered, 0),
  };
}
function cooking(db, user, fid, method, body) {
  S.membership(db, user, fid, true);
  if (method === 'GET')
    return {
      dishIds: db.cookingRecords
        .filter(
          (c) =>
            c.userId === user.id &&
            c.familyId === fid &&
            c.date === body.date &&
            c.slot === body.slot,
        )
        .map((c) => c.dishId),
    };
  S.fail('请在当日菜单逐道勾选已做完', 410, 'COOK_FLOW_CHANGED');
}
module.exports = { security, credentials, archive, achievements, cooking };
