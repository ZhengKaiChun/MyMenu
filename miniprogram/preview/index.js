// Offline preview transport. Only selected explicitly by config.mode='preview'.
// This store is device-local; it is never used for formal WeChat authentication or shared data.
const S = require('./store'),
  hash = require('./hash'),
  { today } = require('./seed');
function allowed() {
  const info = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null;
  S.demand(
    info?.miniProgram?.envVersion !== 'release',
    '正式版需要配置独立后端，不能使用本机体验数据',
    503,
    'PREVIEW_NOT_PRODUCTION',
  );
}
function cleanUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    avatarId: u.avatarId || null,
    phoneBound: false,
    wechatBound: false,
  };
}
function login(db, u) {
  const token = S.id();
  db.sessions[token] = u.id;
  return { token, user: cleanUser(u) };
}
function request(path, options = {}, token) {
  allowed();
  const db = S.read(),
    method = options.method || 'GET',
    body = options.body || {};
  const split = path.split('?'),
    parts = split[0].split('/').filter(Boolean).map(decodeURIComponent),
    query = {};
  for (const pair of (split[1] || '').split('&')) {
    const [k, v] = pair.split('=');
    if (k) query[k] = decodeURIComponent(v || '');
  }
  const operationKey = options.key ? (db.sessions[token] || 'public') + ':' + options.key : null;
  const operation = operationKey && db.operations[operationKey];
  if (operation) {
    S.demand(
      operation.path === path && operation.body === JSON.stringify(body),
      '重复操作内容发生变化',
      409,
    );
    return Promise.resolve(S.clone(operation.result));
  }
  let out;
  if (parts[0] === 'capabilities')
    out = {
      preview: true,
      wechat: true,
      wechatPhone: false,
      sms: false,
      subscriptionTemplateId: null,
    };
  else if (parts[0] === 'auth') {
    if (parts[1] === 'preview')
      out = login(
        db,
        db.users.find((u) => u.id === (body.role === 'eater' ? 'preview-eater' : 'preview-cook')),
      );
    else if (parts[1] === 'register') {
      S.demand(/^[A-Za-z0-9_]{4,32}$/.test(body.username), '账号需要4–32位字母、数字或下划线');
      S.demand(
        typeof body.password === 'string' &&
          body.password.length >= 10 &&
          body.password.length <= 128,
        '体验密码需要10–128位，请勿使用真实密码',
      );
      S.demand(!db.users.some((u) => u.username === body.username), '这个账号已经存在', 409);
      const u = {
        id: S.id(),
        username: body.username,
        nickname: '野生小猪',
        avatarId: null,
        salt: S.id(),
      };
      u.passwordHash = hash(u.salt + body.password);
      db.users.push(u);
      out = login(db, u);
    } else if (parts[1] === 'password') {
      const u = db.users.find((u) => u.username === body.username);
      S.demand(
        u?.passwordHash && hash(u.salt + body.password) === u.passwordHash,
        '账号或密码不正确',
        401,
        'INVALID_CREDENTIALS',
      );
      out = login(db, u);
    } else if (parts[1] === 'logout') {
      delete db.sessions[token];
      out = { ok: true };
    } else S.fail('本机体验不发送短信或调用微信真实登录，请使用直接体验');
  } else {
    const user = db.users.find((u) => u.id === db.sessions[token] && !u.deleted_at);
    S.demand(user, '请重新进入体验', 401, 'SESSION_EXPIRED');
    if (parts[0] === 'me') {
      if (method === 'GET') out = cleanUser(user);
      else if (method === 'PATCH') {
        S.demand(typeof body.nickname === 'string' && body.nickname.trim(), '请填写昵称');
        user.nickname = body.nickname.trim().slice(0, 30);
        user.avatarId = body.avatarId;
        out = cleanUser(user);
      } else if (method === 'DELETE') {
        S.demand(
          !db.families.some((f) => !f.deleted_at && f.owner_id === user.id),
          '请先转让或解散你创建的小家',
          409,
        );
        user.deleted_at = new Date().toISOString();
        db.members = db.members.filter((m) => m.user_id !== user.id);
        out = { ok: true };
      } else S.fail('此功能需要正式后台服务');
    } else if (parts[0] === 'families' && parts.length === 1) {
      out = method === 'GET' ? S.homes(db, user) : S.createHome(db, user, body.name);
    } else if (parts[0] === 'families') {
      const fid = parts[1],
        m = S.membership(db, user, fid),
        f = db.families.find((f) => f.id === fid),
        section = parts[2],
        rid = parts[3];
      const cook = () => S.membership(db, user, fid, true),
        owner = () => S.demand(f.owner_id === user.id, '只有创建者可以操作', 403);
      if (!section && method === 'PATCH') {
        owner();
        S.demand(f.version === body.version, '小家已有更新，请刷新', 409);
        f.name = String(body.name).trim().slice(0, 40);
        S.demand(f.name, '请填写小家名称');
        f.version++;
        out = { ok: true };
      } else if (section === 'menu')
        out = {
          family: { ...m, memberCount: db.members.filter((x) => x.family_id === fid).length },
          collections: db.collections
            .filter((c) => c.family_id === fid)
            .sort((a, b) => a.sort_order - b.sort_order),
          dishes: db.dishes
            .filter((d) => d.family_id === fid && !d.archived)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map(S.publicDish),
        };
      else if (section === 'menu-layout') {
        cook();
        S.demand(f.version === body.version, '菜单已被修改，请重新载入', 409);
        S.demand(body.collections.length, '至少保留一个合集');
        const old = db.dishes.filter((d) => d.family_id === fid && !d.archived);
        S.demand(
          old.every(
            (d) => body.dishes.some((x) => x.id === d.id) || body.deletedDishIds.includes(d.id),
          ),
          '草稿缺少菜品',
        );
        const cmap = {};
        const names = new Set();
        for (const [sort, c] of body.collections.entries()) {
          S.demand(!names.has(c.name) && c.name.trim(), '合集名称重复或为空');
          names.add(c.name);
          const existing = db.collections.find((x) => x.id === c.id && x.family_id === fid);
          S.demand(existing || c.id.startsWith('draft-'), '合集不属于当前小家');
          const cid = existing?.id || S.id();
          cmap[c.id] = cid;
          if (existing) Object.assign(existing, { name: c.name, sort_order: sort });
          else db.collections.push({ id: cid, family_id: fid, name: c.name, sort_order: sort });
        }
        for (const id of body.deletedDishIds) {
          const d = S.findDish(db, fid, id);
          d.archived = true;
          d.version++;
        }
        const dmap = {};
        for (const e of body.recipes) {
          const d = e.id.startsWith('draft-') ? null : S.findDish(db, fid, e.id);
          if (d) S.demand(d.version === e.body.version, '菜品已更新', 409);
          S.demand(e.body.name.trim() && cmap[e.body.collectionId], '请填写菜名并选择合集');
          const out = {
            ...e.body,
            id: d?.id || S.id(),
            family_id: fid,
            collectionId: cmap[e.body.collectionId],
            version: (d?.version || 0) + 1,
            archived: false,
          };
          dmap[e.id] = out.id;
          if (d) Object.assign(d, out);
          else db.dishes.push(out);
        }
        for (const [sort, d] of body.dishes.entries()) {
          const row = S.findDish(db, fid, dmap[d.id] || d.id);
          S.demand(cmap[d.collectionId], '请先移动被删除合集中的菜品');
          row.collectionId = cmap[d.collectionId];
          row.sortOrder = sort;
          row.version++;
        }
        const keep = Object.values(cmap);
        for (const d of db.dishes)
          if (d.family_id === fid && !keep.includes(d.collectionId)) d.collectionId = keep[0];
        db.collections = db.collections.filter((c) => c.family_id !== fid || keep.includes(c.id));
        f.version++;
        out = { ok: true };
      } else if (section === 'members') {
        if (method === 'GET')
          out = db.members
            .filter((x) => x.family_id === fid)
            .map((x) => ({
              ...x,
              nickname: db.users.find((u) => u.id === x.user_id).nickname,
              avatar_id: db.users.find((u) => u.id === x.user_id).avatarId,
            }));
        else {
          owner();
          const target = S.demand(
            db.members.find((x) => x.family_id === fid && x.user_id === rid),
            '成员不存在',
          );
          S.demand(target.user_id !== f.owner_id, '创建者不能取消自己的管理身份');
          S.demand(['cook', 'eater'].includes(body.role), '请选择有效角色');
          target.role = body.role;
          out = { ok: true };
        }
      } else if (section === 'identity') {
        const names = ['野生小猪', '猪爸爸', '猪妈妈', '猪大二', '猪二儿', '猪大妞', '猪二妞'];
        S.demand(names.includes(body.identity), '请选择家庭身份');
        db.members.find((x) => x.family_id === fid && x.user_id === user.id).identity =
          body.identity;
        out = { ok: true };
      } else if (section === 'transfer') {
        owner();
        const target = S.demand(
          db.members.find((x) => x.family_id === fid && x.user_id === body.userId),
          '请选择家庭成员',
        );
        f.owner_id = target.user_id;
        target.role = 'cook';
        f.version++;
        out = { ok: true };
      } else if (section === 'leave') {
        S.demand(f.owner_id !== user.id, '创建者请先转让小家', 409);
        db.members = db.members.filter((x) => !(x.family_id === fid && x.user_id === user.id));
        invalidate(db, fid);
        out = { ok: true };
      } else if (section === 'collections') {
        cook();
        if (method === 'POST') {
          S.demand(body.name?.trim(), '请填写合集名称');
          S.demand(
            !db.collections.some((c) => c.family_id === fid && c.name === body.name.trim()),
            '合集名称已存在',
            409,
          );
          out = {
            id: S.id(),
            family_id: fid,
            name: body.name.trim(),
            sort_order: db.collections.filter((c) => c.family_id === fid).length,
          };
          db.collections.push(out);
        } else {
          const c = S.demand(
            db.collections.find((c) => c.id === rid && c.family_id === fid),
            '合集不存在',
            404,
          );
          if (method === 'PATCH') c.name = S.demand(body.name?.trim(), '请填写合集名称');
          else {
            S.demand(
              !db.dishes.some((d) => d.collectionId === rid && !d.archived),
              '请先移动合集中的菜品',
              409,
            );
            db.collections = db.collections.filter((x) => x !== c);
          }
          out = { ok: true };
        }
        f.version++;
      } else if (section === 'dishes') {
        if (method === 'GET') {
          cook();
          out = S.findDish(db, fid, rid);
        } else {
          cook();
          if (method === 'DELETE') {
            const d = S.findDish(db, fid, rid);
            d.archived = true;
            d.version++;
            out = { ok: true };
          } else {
            S.demand(body.name?.trim(), '请填写菜名');
            S.demand(
              body.ingredients.every(
                (i) =>
                  i.name?.trim() &&
                  Number.isFinite(i.quantity) &&
                  i.quantity >= 0 &&
                  i.unit?.trim(),
              ),
              '请完整填写用料',
            );
            S.demand(
              body.steps.every((s) => s.text?.trim()),
              '请填写每一步做法',
            );
            S.demand(
              db.collections.some((c) => c.id === body.collectionId && c.family_id === fid),
              '请选择本小家的合集',
            );
            const old = rid ? S.findDish(db, fid, rid) : null;
            if (old) S.demand(old.version === body.version, '菜品已更新，请刷新', 409);
            const d = {
              ...body,
              id: old?.id || S.id(),
              family_id: fid,
              version: (old?.version || 0) + 1,
              sortOrder: old?.sortOrder || db.dishes.length,
              archived: false,
            };
            if (old) db.dishes[db.dishes.indexOf(old)] = d;
            else db.dishes.push(d);
            out = { id: d.id };
          }
          f.version++;
        }
      } else if (section === 'sort') {
        cook();
        const list = body.type === 'collections' ? db.collections : db.dishes;
        for (const [index, id] of body.ids.entries()) {
          const entry = S.demand(
            list.find((d) => d.id === id && d.family_id === fid),
            '排序项目不属于这个小家',
          );
          entry[body.type === 'collections' ? 'sort_order' : 'sortOrder'] = index;
        }
        f.version++;
        out = { ok: true };
      } else if (section === 'inventory')
        out = inventory(db, user, fid, method, parts.slice(3), body, () => {});
      else if (section === 'prep') {
        cook();
        const date = query.date || body.date;
        if (method === 'PUT') {
          db.checks[fid + date] = body.items;
          out = { ok: true };
        } else {
          const map = {};
          for (const o of db.orders.filter(
            (o) => o.family_id === fid && o.meal_date === date && o.status === 'accepted',
          ))
            for (const l of o.items)
              for (const i of l.snapshot.ingredients) {
                const key = i.name + '|' + i.unit;
                if (!map[key]) map[key] = { ...i, quantity: 0, sources: [] };
                map[key].quantity += i.quantity * l.quantity;
                if (!map[key].sources.includes(l.snapshot.name))
                  map[key].sources.push(l.snapshot.name);
              }
          out = Object.values(map).map((i) => {
            const owned = db.inventories.some(
              (v) => v.family_id === fid && v.name === i.name && v.unit === i.unit,
            );
            return {
              ...i,
              owned,
              checked:
                (db.checks[fid + date] || []).find((x) => x.name === i.name && x.unit === i.unit)
                  ?.checked ?? owned,
            };
          });
        }
      } else if (section === 'match') {
        cook();
        let names = (query.ingredients || '')
          .split(/[,+，、]/)
          .map((x) => x.trim())
          .filter(Boolean);
        if (!names.length)
          names = db.inventories.filter((i) => i.family_id === fid).map((i) => i.name);
        out = db.dishes
          .filter((d) => d.family_id === fid && !d.archived)
          .map((d) => ({
            ...S.publicDish(d),
            matched: d.ingredients.filter((i) => names.includes(i.name)).length,
            missing: d.ingredients.filter((i) => !names.includes(i.name)).map((i) => i.name),
          }))
          .filter((d) => d.matched)
          .sort((a, b) => b.matched - a.matched);
      } else if (section === 'invitations') {
        cook();
        if (body.role === 'cook') owner();
        S.demand(['cook', 'eater'].includes(body.role), '请选择邀请身份');
        const i = {
          token: S.id(),
          family_id: fid,
          role: body.role,
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          revoked: false,
        };
        db.invitations.push(i);
        out = { ...i, title: body.role === 'cook' ? '邀请你一起打扫猪圈' : '邀请你加入他的猪圈' };
      } else if (section === 'orders') {
        if (method === 'GET')
          out = db.orders
            .filter((o) => o.family_id === fid && (m.role === 'cook' || o.user_id === user.id))
            .slice()
            .reverse()
            .map((o) => ({
              ...o,
              nickname: db.users.find((u) => u.id === o.user_id).nickname,
              identity:
                db.members.find((x) => x.family_id === fid && x.user_id === o.user_id)?.identity ||
                '野生小猪',
              items: o.items.map((l) => ({ ...l, snapshot: S.publicDish(l.snapshot) })),
            }));
        else if (!rid) {
          S.demand(body.items?.length, '菜篮还是空的');
          S.demand(
            /^\d{4}-\d{2}-\d{2}$/.test(body.date) && body.date >= today(),
            '请选择今天或之后的日期',
          );
          S.demand(['早餐', '午餐', '晚餐'].includes(body.slot), '请选择餐次');
          const o = {
            id: S.id(),
            family_id: fid,
            user_id: user.id,
            meal_date: body.date,
            slot: body.slot,
            status: m.role === 'cook' ? 'accepted' : 'pending',
            note: body.note || '',
            reply: '',
            version: 1,
            created_at: new Date().toISOString(),
            items: body.items.map((i) => {
              const d = S.findDish(db, fid, i.dishId);
              S.demand(
                !d.archived && Number.isInteger(i.quantity) && i.quantity > 0 && i.quantity <= 99,
                '请选择有效菜品和份数',
              );
              return {
                id: S.id(),
                dish_id: d.id,
                quantity: i.quantity,
                snapshot: S.clone(d),
                done: false,
              };
            }),
          };
          db.orders.push(o);
          if (o.status === 'pending')
            S.notify(db, fid, 'order.pending', o.id, '您小猪发来了一条吃饭申请');
          S.notify(
            db,
            fid,
            'order.sent',
            o.id,
            o.status === 'pending' ? '心愿已寄出，等饲养员回音' : '这顿安排啦，已加入全家菜单',
            [user.id],
          );
          out = { id: o.id, status: o.status };
        } else {
          const o = S.demand(
            db.orders.find((o) => o.id === rid && o.family_id === fid),
            '点菜不存在',
            404,
          );
          S.demand(o.status === 'pending', '这份点菜已处理', 409);
          if (parts[4] === 'reply') {
            cook();
            S.demand(
              !db.changes.some(
                (c) => c.status === 'pending' && o.items.some((l) => l.id === c.line_id),
              ),
              '请先处理换菜申请',
              409,
            );
            o.status = body.decision === 'accept' ? 'accepted' : 'rejected';
            o.reply = body.reply || '';
            S.notify(db, fid, 'order.reply', o.id, o.reply || '饲养员回复了你的点菜', [o.user_id]);
          } else {
            S.demand(o.user_id === user.id, '只能撤回自己的点菜', 403);
            o.status = 'cancelled';
            for (const c of db.changes)
              if (o.items.some((l) => l.id === c.line_id) && c.status === 'pending')
                c.status = 'cancelled';
          }
          o.version++;
          out = { ok: true };
        }
      } else if (section === 'meal-dates') {
        out = [
          ...new Set(
            db.orders
              .filter(
                (o) =>
                  o.family_id === fid &&
                  o.status === 'accepted' &&
                  o.meal_date >= query.from &&
                  o.meal_date <= query.to &&
                  (query.done !== '1' || o.meal_date < today() || o.items.some((l) => l.done)),
              )
              .map((o) => o.meal_date),
          ),
        ]
          .sort()
          .map((date) => ({ date }));
      } else if (section === 'meals') out = S.meals(db, fid, query.date);
      else if (section === 'my-lines') out = S.eligible(db, user, fid);
      else if (section === 'lines') {
        cook();
        const o = S.demand(
          db.orders.find(
            (o) =>
              o.family_id === fid && o.status === 'accepted' && o.items.some((l) => l.id === rid),
          ),
          '找不到这道已安排的菜',
          404,
        );
        o.items.find((l) => l.id === rid).done = true;
        out = { ok: true };
      } else if (section === 'changes')
        out = changes(db, user, fid, m, method, rid, parts[4], body);
      else if (section === 'shares') {
        cook();
        S.demand(body.dishIds?.length, '至少选择一道菜');
        const share = {
          id: S.id(),
          token: S.id(),
          source_family_id: fid,
          sender_id: user.id,
          snapshot: body.dishIds.map((id) => ({
            ...S.clone(S.findDish(db, fid, id)),
            category:
              db.collections.find((c) => c.id === S.findDish(db, fid, id).collectionId)?.name ||
              '分享好菜',
          })),
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          revoked: false,
        };
        db.shares.push(share);
        out = { id: share.id, token: share.token, count: share.snapshot.length };
      } else if (section === 'dissolution')
        out = dissolve(db, user, fid, method, rid, parts[4], body);
      else S.fail('这个预览页面暂不可用', 404);
    } else if (parts[0] === 'inventory')
      out = inventory(db, user, null, method, parts.slice(1), body, () => {});
    else if (parts[0] === 'notifications') {
      if (parts[1] === 'preferences') {
        if (method === 'PATCH') {
          S.demand(typeof body.enabled === 'boolean', '请选择是否开启开饭通知');
          user.notificationsEnabled = body.enabled;
        }
        out = { enabled: user.notificationsEnabled !== false };
      } else if (method === 'GET') out = db.notifications.filter((n) => n.user_id === user.id);
      else if (parts[1] === 'delete') {
        const before = db.notifications.length;
        db.notifications = db.notifications.filter(
          (n) => n.user_id !== user.id || !body.ids.includes(n.id),
        );
        out = { deleted: before - db.notifications.length };
      } else if (parts[2] === 'read') {
        const n = S.demand(
          db.notifications.find((n) => n.id === parts[1] && n.user_id === user.id),
          '消息不存在',
          404,
        );
        n.read_at = new Date().toISOString();
        out = { ok: true };
      } else S.fail('微信外部提醒需配置正式后台；站内回音正常可用');
    } else if (parts[0] === 'invitations') {
      const i = S.demand(
          db.invitations.find(
            (i) => i.token === parts[1] && !i.revoked && i.expires_at > new Date().toISOString(),
          ),
          '邀请已失效，请重新寄一封',
          410,
          'INVITATION_EXPIRED',
        ),
        f = S.demand(
          db.families.find((f) => f.id === i.family_id && !f.deleted_at),
          '这个小家已解散',
          410,
        );
      if (method === 'GET') out = { role: i.role, expires_at: i.expires_at, name: f.name };
      else {
        let existing = db.members.find((m) => m.family_id === f.id && m.user_id === user.id);
        if (!existing) {
          S.demand(!i.consumed_by, '这封邀请已经被使用', 409);
          db.members.push({
            family_id: f.id,
            user_id: user.id,
            role: i.role,
            identity: '野生小猪',
          });
          i.consumed_by = user.id;
          invalidate(db, f.id);
        }
        out = { familyId: f.id, role: existing?.role || i.role };
      }
    } else if (parts[0] === 'shares') {
      const s = packet(db, parts[1]);
      if (method === 'GET')
        out = {
          id: s.id,
          sender: db.users.find((u) => u.id === s.sender_id).nickname,
          family: db.families.find((f) => f.id === s.source_family_id).name,
          expiresAt: s.expires_at,
          dishes: s.snapshot,
        };
      else {
        S.demand(s.sender_id === user.id, '只能撤回自己的分享', 403);
        s.revoked = true;
        out = { ok: true };
      }
    } else if (parts[0] === 'imports') out = imports(db, user, body, parts[1] === 'preview');
    else S.fail('此功能需配置正式后台服务', 400);
  }
  S.demand(out !== undefined, '这个操作暂不可用');
  if (method !== 'GET' && options.key)
    db.operations[operationKey] = { path, body: JSON.stringify(body), result: S.clone(out) };
  // Save initialization too, so all pages share one deterministic device-local store.
  S.save(db);
  return Promise.resolve(S.clone(out));
}
function invalidate(db, fid) {
  for (const p of db.proposals)
    if (p.family_id === fid && p.status === 'pending') p.status = 'invalidated';
}
function inventory(db, user, fid, method, parts, b, cook) {
  const own = (i) => (fid ? i.family_id === fid : i.user_id === user.id);
  let rows = db.inventories.filter(own);
  if (method === 'GET') return rows;
  cook();
  if (parts[0] === 'import') {
    for (const iid of b.ids) {
      const i = S.demand(
        db.inventories.find((i) => i.id === iid && i.user_id === user.id),
        '只能导入自己的食材',
      );
      if (!rows.some((v) => v.name === i.name && v.unit === i.unit)) {
        const entry = { ...i, id: S.id(), family_id: fid, user_id: null, version: 1 };
        db.inventories.push(entry);
        rows.push(entry);
      }
    }
    return { ok: true };
  }
  const current = parts[0]
    ? S.demand(
        rows.find((i) => i.id === parts[0]),
        '食材不存在',
        404,
      )
    : rows.find((i) => i.name === b.name && i.unit === b.unit);
  if (method === 'DELETE') {
    db.inventories = db.inventories.filter((i) => i !== current);
    return { ok: true };
  }
  S.demand(
    b.name?.trim() && b.unit?.trim() && Number.isFinite(b.quantity) && b.quantity >= 0,
    '请完整填写食材名称、数量和单位',
  );
  if (method === 'PUT') S.demand(current.version === b.version, '食材已更新，请刷新后编辑', 409);
  const entry = {
    ...b,
    id: current?.id || S.id(),
    version: (current?.version || 0) + 1,
    ...(fid ? { family_id: fid } : { user_id: user.id }),
  };
  if (current) db.inventories[db.inventories.indexOf(current)] = entry;
  else db.inventories.push(entry);
  return { id: entry.id };
}
function changes(db, user, fid, m, method, rid, action, b) {
  const all = db.changes.filter(
    (c) => c.family_id === fid && (m.role === 'cook' || c.user_id === user.id),
  );
  if (method === 'GET')
    return all.map((c) => {
      const order = db.orders.find((o) => o.items.some((l) => l.id === c.line_id));
      const line = order?.items.find((l) => l.id === c.line_id);
      return {
        ...c,
        meal_date: order?.meal_date || '',
        slot: order?.slot || '',
        quantity: line?.quantity || 0,
        nickname: db.users.find((u) => u.id === c.user_id)?.nickname || '野生小猪',
        old_snapshot: S.publicDish(c.old_snapshot),
        new_snapshot: S.publicDish(c.new_snapshot),
      };
    });
  if (!rid) {
    const line = S.demand(
      S.eligible(db, user, fid).find((l) => l.id === b.lineId),
      '只能更换自己的未完成点菜',
      403,
    );
    S.demand(
      !db.changes.some((c) => c.line_id === line.id && c.status === 'pending'),
      '这道菜正在等换菜回音',
      409,
    );
    const d = S.findDish(db, fid, b.replacementId);
    S.demand(d.id !== line.dish_id && !d.archived, '请选择另一道在售菜品');
    const c = {
      id: S.id(),
      family_id: fid,
      line_id: line.id,
      user_id: user.id,
      replacement_id: d.id,
      line_version: line.version,
      status: 'pending',
      reason: b.reason || '',
      reply: '',
      old_snapshot: line.snapshot,
      new_snapshot: S.clone(d),
      created_at: new Date().toISOString(),
    };
    db.changes.push(c);
    S.notify(db, fid, 'change.pending', c.id, '小猪想换一道菜，等你回音');
    return { id: c.id };
  }
  const c = S.demand(
    all.find((c) => c.id === rid),
    '换菜申请不存在',
    404,
  );
  S.demand(c.status === 'pending', '这份换菜已处理', 409);
  if (action === 'withdraw') {
    S.demand(c.user_id === user.id, '只能撤回自己的申请', 403);
    c.status = 'cancelled';
    return { ok: true };
  }
  S.membership(db, user, fid, true);
  const o = S.demand(
      db.orders.find((o) => o.family_id === fid && o.items.some((l) => l.id === c.line_id)),
      '原点菜已不存在',
      409,
    ),
    l = o.items.find((l) => l.id === c.line_id);
  S.demand(
    o.version === c.line_version && !l.done && ['pending', 'accepted'].includes(o.status),
    '点菜已变化，请重新申请',
    409,
  );
  c.status = b.decision === 'accept' ? 'accepted' : 'rejected';
  c.reply = b.reply || '';
  if (c.status === 'accepted') {
    l.dish_id = c.replacement_id;
    l.snapshot = S.clone(c.new_snapshot);
    if (o.status === 'pending') o.status = 'accepted';
    o.version++;
  }
  S.notify(db, fid, 'change.reply', c.id, c.reply || '饲养员回复了换菜申请', [c.user_id]);
  return { ok: true };
}
function dissolve(db, user, fid, method, rid, action, b) {
  const proposals = db.proposals.filter((p) => p.family_id === fid);
  if (method === 'GET') return proposals[proposals.length - 1] || null;
  let p;
  if (!rid) {
    S.demand(db.families.find((f) => f.id === fid).owner_id === user.id, '只有创建者可以发起', 403);
    S.demand(!proposals.some((p) => p.status === 'pending'), '已经有一封解散确认在等回音', 409);
    p = {
      id: S.id(),
      family_id: fid,
      initiator: user.id,
      status: 'pending',
      created_at: new Date().toISOString(),
      votes: db.members
        .filter((m) => m.family_id === fid)
        .map((m) => ({
          user_id: m.user_id,
          decision: m.user_id === user.id ? 'agree' : null,
          nickname: db.users.find((u) => u.id === m.user_id).nickname,
          identity: m.identity,
        })),
    };
    db.proposals.push(p);
    S.notify(
      db,
      fid,
      'dissolution.pending',
      p.id,
      '确定要解散小家吗？等每只小猪的回音',
      p.votes.map((v) => v.user_id),
    );
  } else {
    p = S.demand(
      proposals.find((p) => p.id === rid),
      '申请不存在',
      404,
    );
    S.demand(p.status === 'pending', '这封确认已结束', 409);
    if (action === 'cancel') {
      S.demand(p.initiator === user.id, '只有发起人可以撤回', 403);
      p.status = 'cancelled';
      return { ok: true };
    }
    const v = S.demand(
      p.votes.find((v) => v.user_id === user.id && !v.decision),
      '你已回复或不能参与',
      409,
    );
    S.demand(['agree', 'reject'].includes(b.decision), '请选择同意或保留');
    v.decision = b.decision;
    if (b.decision === 'reject') p.status = 'rejected';
  }
  if (p.status === 'pending' && p.votes.every((v) => v.decision === 'agree')) {
    p.status = 'completed';
    db.families.find((f) => f.id === fid).deleted_at = new Date().toISOString();
    for (const i of db.invitations) if (i.family_id === fid) i.revoked = true;
    for (const s of db.shares) if (s.source_family_id === fid) s.revoked = true;
    S.notify(
      db,
      fid,
      'dissolution.complete',
      p.id,
      '全员同意，小家已解散',
      p.votes.map((v) => v.user_id),
    );
  }
  return { id: p.id, status: p.status };
}
function packet(db, token) {
  const s = S.demand(
    db.shares.find(
      (s) => s.token === token && !s.revoked && s.expires_at > new Date().toISOString(),
    ),
    '菜谱分享已失效，请重新寄一封',
    410,
    'SHARE_EXPIRED',
  );
  S.demand(
    db.families.some((f) => f.id === s.source_family_id && !f.deleted_at),
    '来源小家已解散',
    410,
  );
  return s;
}
function imports(db, user, b, preview) {
  const s = packet(db, b.token),
    m = b.familyId ? S.membership(db, user, b.familyId, true) : null;
  S.demand(!!b.familyId !== !!b.newFamilyName, '选择一个小家或新建小家');
  const old = db.dishes.filter((d) => d.family_id === b.familyId && !d.archived),
    matching = s.snapshot.filter((d) => old.some((o) => o.name === d.name)).length;
  const result = {
    count: s.snapshot.length,
    version: m?.version || 1,
    target: m?.name || b.newFamilyName,
    added:
      b.mode === 'add' || !m || b.scope === 'whole'
        ? s.snapshot.length
        : s.snapshot.length - matching,
    replaced: b.mode === 'overwrite' && m ? (b.scope === 'whole' ? old.length : matching) : 0,
    names: s.snapshot.map((d) => d.name),
  };
  if (preview) return result;
  if (m) S.demand(m.version === b.version, '目标小家的菜谱已变化，请重新确认', 409);
  const f = m ? db.families.find((f) => f.id === m.id) : S.createHome(db, user, b.newFamilyName);
  if (b.mode === 'overwrite' && b.scope === 'whole')
    old.forEach((d) => {
      d.archived = true;
      d.version++;
    });
  for (const source of s.snapshot) {
    let category = db.collections.find(
      (c) => c.family_id === f.id && c.name === (source.category || '分享好菜'),
    );
    if (!category) {
      category = {
        id: S.id(),
        family_id: f.id,
        name: source.category || '分享好菜',
        sort_order: db.collections.length,
      };
      db.collections.push(category);
    }
    let match =
      b.mode === 'overwrite' && b.scope === 'matching'
        ? old.find((d) => d.name === source.name)
        : null;
    let name = source.name;
    if (b.mode === 'add') {
      let i = 1;
      while (db.dishes.some((d) => d.family_id === f.id && !d.archived && d.name === name))
        name = source.name + '（分享' + i++ + '）';
    }
    const d = {
      ...S.clone(source),
      id: match?.id || S.id(),
      family_id: f.id,
      collectionId: category.id,
      name,
      archived: false,
      version: (match?.version || 0) + 1,
      sortOrder: db.dishes.length,
    };
    if (match) db.dishes[db.dishes.indexOf(match)] = d;
    else db.dishes.push(d);
  }
  f.version++;
  const receipt = {
    id: S.id(),
    familyId: f.id,
    added: result.added,
    replaced: result.replaced,
    count: result.count,
  };
  db.receipts.push(receipt);
  return receipt;
}
function image(id, fallback) {
  allowed();
  if (/^preview-food-[0-3]$/.test(id)) return '/assets/food-' + id.slice(-1) + '.jpg';
  return S.read().media[id] || fallback;
}
async function upload(tempFilePath) {
  allowed();
  const result = await new Promise((resolve, reject) =>
    wx.getFileSystemManager().saveFile({ tempFilePath, success: resolve, fail: reject }),
  );
  const db = S.read(),
    id = S.id();
  db.media[id] = result.savedFilePath;
  S.save(db);
  return { id };
}
module.exports = { request, image, upload };
