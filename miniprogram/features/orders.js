const { createPage, go, decorate, familyPath, session, api } = require('../lib/page');
const labels = {
  pending: '等你回音',
  accepted: '这顿安排啦',
  rejected: '这次先不做',
  cancelled: '已撤回',
  obsolete: '点菜有变化，请重新选择',
};
const identityIndex = { 猪爸爸: 1, 猪妈妈: 2, 猪大二: 3, 猪二儿: 4, 猪大妞: 5, 猪二妞: 6 };
exports.checkout = createPage({
  data: { items: [], count: 0, note: '', date: '', slot: '晚餐' },
  async reload() {
    const menu = await api.request(familyPath('/menu'));
    const dishes = await decorate(menu.dishes);
    const items = dishes
      .filter((d) => session.cart[d.id])
      .map((d) => ({ ...d, quantity: session.cart[d.id] }));
    this.setData({
      items,
      count: items.reduce((n, d) => n + d.quantity, 0),
      date: session.mealDate || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
      slot: session.mealSlot || '晚餐',
    });
  },
  methods: {
    async quantity(e) {
      const id = e.currentTarget.dataset.id,
        dir = Number(e.currentTarget.dataset.dir);
      session.cart[id] = Math.max(0, Math.min(99, (session.cart[id] || 0) + dir));
      if (!session.cart[id]) delete session.cart[id];
      await this.onShow();
    },
    date(e) {
      this.setData({ date: e.detail.value });
      session.mealDate = e.detail.value;
    },
    meal(e) {
      this.setData({ slot: e.currentTarget.dataset.slot });
      session.mealSlot = this.data.slot;
    },
    async submit() {
      if (!this.data.items.length) throw Error('菜篮还是空的');
      const out = await api.request(familyPath('/orders'), {
        method: 'POST',
        body: {
          date: this.data.date,
          slot: this.data.slot,
          note: this.data.note,
          items: this.data.items.map((d) => ({ dishId: d.id, quantity: d.quantity })),
        },
      });
      session.cart = {};
      session.lastOrder = out;
      session.mealDate = this.data.date;
      wx.redirectTo({ url: '/pages/sent/index' });
    },
  },
});
exports.sent = createPage({
  data: { accepted: false },
  async reload() {
    this.setData({
      accepted: session.lastOrder?.status === 'accepted',
      date: session.mealDate,
      slot: session.mealSlot || '晚餐',
    });
  },
});
async function loadRequests() {
  const [orders, changes, notifications] = await Promise.all([
    api.request(familyPath('/orders')),
    api.request(familyPath('/changes')),
    api.request('/notifications'),
  ]);
  const mapped = await Promise.all(
    orders.map(async (o) => ({
      ...o,
      label: labels[o.status],
      items: await Promise.all(
        o.items.map(async (l) => ({
          ...l,
          name: l.snapshot.name,
          cover: await api.image(l.snapshot.coverId),
          quantity: l.quantity,
        })),
      ),
    })),
  );
  this.setData({
    notifications: notifications
      .filter((n) => !n.read_at && n.type.startsWith('dissolution'))
      .slice(0, 10),
    orders: mapped,
    changes: await decorateChanges(changes),
    isCook: session.family.role === 'cook',
  });
}
exports.requests = createPage({
  data: { orders: [], changes: [], notifications: [] },
  reload: loadRequests,
  methods: {
    async notification(e) {
      const item = this.data.notifications.find((n) => n.id === e.currentTarget.dataset.id);
      await api.request('/notifications/' + item.id + '/read', { method: 'POST', body: {} });
      if (item.type === 'dissolution.complete') {
        wx.showModal({ title: '小家消息', content: item.body, showCancel: false });
        return;
      }
      go('dissolve', { familyId: item.family_id });
    },
  },
});
exports.requestDetail = createPage({
  data: { order: null, showReply: false, reply: '', decision: 'accept' },
  async reload() {
    const orders = await api.request(familyPath('/orders'));
    const order = orders.find((o) => o.id === this.query.id);
    if (!order) throw Error('这份点菜已不存在或没有访问权限');
    order.items = await Promise.all(
      order.items.map(async (l) => ({
        ...l,
        name: l.snapshot.name,
        cover: await api.image(l.snapshot.coverId),
      })),
    );
    this.setData({
      order,
      label: labels[order.status],
      isCook: session.family.role === 'cook',
      isMine: order.user_id === session.user.id,
    });
  },
  methods: {
    reply(e) {
      this.setData({ decision: e.currentTarget.dataset.decision, showReply: true });
    },
    closeReply() {
      this.setData({ showReply: false });
    },
    async confirmReply() {
      await api.request(familyPath('/orders/' + this.data.order.id + '/reply'), {
        method: 'POST',
        body: { decision: this.data.decision, reply: this.data.reply },
      });
      this.setData({ showReply: false });
      await this.onShow();
    },
    async cancel() {
      await api.request(familyPath('/orders/' + this.data.order.id + '/cancel'), {
        method: 'POST',
        body: {},
      });
      await this.onShow();
    },
  },
});
async function loadToday() {
  const date =
    this.data.date ||
    this.query.date ||
    session.mealDate ||
    new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  let meal = await api.request(familyPath('/meals') + '?date=' + date);
  let dishes = await decorate(meal.dishes.map((d) => ({ ...d, ...d.snapshot })));
  if (this.historyOnly)
    dishes = dishes
      .map((d) => ({ ...d, sources: d.sources.filter((s) => s.done) }))
      .filter((d) => d.sources.length)
      .map((d) => ({ ...d, quantity: d.sources.reduce((n, s) => n + s.quantity, 0) }));
  const sections = ['早餐', '午餐', '晚餐'].map((slot) => ({
    slot,
    dishes: dishes
      .filter((d) => d.slot === slot)
      .map((d) => ({
        ...d,
        sources: d.sources.map((s) => ({ ...s, pig: identityIndex[s.identity] || 7 })),
      })),
  }));
  this.setData({
    date,
    sections,
    total: dishes.length,
    quantity: dishes.reduce((n, d) => n + d.quantity, 0),
    isCook: session.family.role === 'cook',
  });
}
const todayMethods = {
  async date(e) {
    this.setData({ date: e.detail.value });
    session.mealDate = e.detail.value;
    await loadToday.call(this);
  },
  prep() {
    go('shopping', { date: this.data.date });
  },
  async done(e) {
    const id = e.currentTarget.dataset.id;
    await api.request(familyPath('/lines/' + id + '/done'), { method: 'POST', body: {} });
    await loadToday.call(this);
  },
};
exports.today = createPage({
  data: { date: '', sections: [] },
  reload: loadToday,
  methods: todayMethods,
});
exports.calendar = exports.today;
exports.history = createPage({
  data: { date: '', sections: [] },
  init() {
    this.historyOnly = true;
  },
  reload: loadToday,
  methods: todayMethods,
});
async function decorateChanges(list) {
  return Promise.all(
    list.map(async (c) => ({
      ...c,
      label: labels[c.status],
      oldCover: await api.image(c.old_snapshot.coverId),
      newCover: await api.image(c.new_snapshot.coverId),
    })),
  );
}
exports.changes = createPage({
  data: { lines: [], changes: [] },
  async reload() {
    const [lines, changes] = await Promise.all([
      api.request(familyPath('/my-lines')),
      api.request(familyPath('/changes')),
    ]);
    this.setData({
      lines: await Promise.all(
        lines.map(async (l) => ({
          ...l,
          cover: await api.image(l.snapshot.coverId),
          changing: changes.some((c) => c.line_id === l.id && c.status === 'pending'),
        })),
      ),
      changes: await decorateChanges(changes),
    });
  },
  methods: {
    swap(e) {
      go('swap', { id: e.currentTarget.dataset.id });
    },
  },
});
exports.swap = createPage({
  data: { source: null, dishes: [], selected: '', reason: '' },
  async reload() {
    const lines = await api.request(familyPath('/my-lines'));
    const source = lines.find((l) => l.id === this.query.id);
    if (!source) throw Error('只能更换自己尚未做好的点菜');
    const menu = await api.request(familyPath('/menu'));
    this.setData({
      source: { ...source, cover: await api.image(source.snapshot.coverId) },
      dishes: await decorate(menu.dishes.filter((d) => d.id !== source.dish_id)),
    });
  },
  methods: {
    pick(e) {
      this.setData({ selected: e.currentTarget.dataset.id });
    },
    async submit() {
      if (!this.data.selected) throw Error('选择一道想替换的菜');
      const out = await api.request(familyPath('/changes'), {
        method: 'POST',
        body: {
          lineId: this.data.source.id,
          replacementId: this.data.selected,
          reason: this.data.reason,
        },
      });
      wx.redirectTo({ url: '/pages/changeDetail/index?id=' + out.id });
    },
  },
});
exports.changeDetail = createPage({
  data: { change: null, reply: '' },
  async reload() {
    const list = await decorateChanges(await api.request(familyPath('/changes'))),
      change = list.find((c) => c.id === this.query.id);
    if (!change) throw Error('找不到这份换菜申请');
    this.setData({ change, isCook: session.family.role === 'cook' });
  },
  methods: {
    async reply(e) {
      await api.request(familyPath('/changes/' + this.data.change.id + '/reply'), {
        method: 'POST',
        body: { decision: e.currentTarget.dataset.decision, reply: this.data.reply },
      });
      await this.onShow();
    },
    async withdraw() {
      await api.request(familyPath('/changes/' + this.data.change.id + '/withdraw'), {
        method: 'POST',
        body: {},
      });
      await this.onShow();
    },
  },
});
