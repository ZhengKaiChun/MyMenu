const { createPage, go, decorate, familyPath, session, api } = require('../lib/page');
const labels = {
  pending: '等你回音',
  accepted: '这顿安排啦',
  rejected: '这次先不做',
  cancelled: '已撤回',
  obsolete: '点菜有变化，请重新选择',
};
const identityIndex = { 猪爸爸: 1, 猪妈妈: 2, 猪大儿: 3, 猪二儿: 4, 猪大妞: 5, 猪二妞: 6 };
exports.checkout = createPage({
  data: { items: [], count: 0, note: '', date: '', slot: '晚餐', showDate: false },
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
    openDate() {
      this.setData({ showDate: true });
    },
    closeDate() {
      this.setData({ showDate: false });
    },
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
      go('sent', {}, { replace: true });
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
const inbox = require('../lib/inbox');
function filterInbox(page) {
  const visible = page.data.notifications
    .filter((n) => inbox.category(n) === page.data.noteTab)
    .sort(
      (a, b) =>
        Number(Boolean(a.read_at)) - Number(Boolean(b.read_at)) ||
        String(b.created_at).localeCompare(String(a.created_at)),
    );
  page.setData({
    visibleNotes: visible,
    noteTabs: inbox.summarize(page.data.notifications),
    selectedNotes: [],
    allNotes: false,
  });
}
async function loadRequests() {
  const [orders, changes, notifications] = await Promise.all([
    api.request(familyPath('/orders')),
    api.request(familyPath('/changes')),
    api.request('/notifications'),
  ]);
  const notes = await Promise.all(
    notifications
      .filter((n) => n.family_id === session.family.id || n.type === 'dissolution.complete')
      .map(async (n) => {
        const order = n.type.startsWith('order.') ? orders.find((o) => o.id === n.entity_id) : null;
        const change = n.type.startsWith('change.')
          ? changes.find((c) => c.id === n.entity_id)
          : null;
        const lines = order?.items || [];
        const snapshots = change
          ? [change.old_snapshot, change.new_snapshot]
          : lines.slice(0, 3).map((l) => l.snapshot);
        return {
          ...n,
          category: inbox.category(n),
          date: n.created_at
            ? new Date(new Date(n.created_at).getTime() + 8 * 3600000)
                .toISOString()
                .slice(0, 16)
                .replace('T', ' ')
            : '',
          status:
            n.type === 'cooking.reminder'
              ? n.invalidated_at
                ? '提醒已失效'
                : '等你确认做菜人'
              : labels[order?.status || change?.status] || '',
          meal: order
            ? order.meal_date + ' · ' + order.slot
            : change
              ? change.meal_date + ' · ' + change.slot
              : '小家的重要消息',
          pictures: await Promise.all(
            snapshots.map(async (d) => ({ name: d.name, cover: await api.image(d.coverId) })),
          ),
        };
      }),
  );
  this.setData({
    notifications: notes,
    noteTab: this.inboxInitialized ? this.data.noteTab : inbox.initial(notes),
  });
  this.inboxInitialized = true;
  filterInbox(this);
}
exports.requests = createPage({
  data: {
    notifications: [],
    visibleNotes: [],
    noteTab: 'order',
    noteTabs: [],
    selectedNotes: [],
    allNotes: false,
  },
  reload: loadRequests,
  methods: {
    tab(e) {
      this.setData({ noteTab: e.currentTarget.dataset.id });
      filterInbox(this);
    },
    selectNotes(e) {
      this.setData({
        selectedNotes: e.detail.value,
        allNotes:
          this.data.visibleNotes.length > 0 &&
          e.detail.value.length === this.data.visibleNotes.length,
      });
    },
    allNotes() {
      const all = !this.data.allNotes;
      this.setData({
        allNotes: all,
        selectedNotes: all ? this.data.visibleNotes.map((n) => n.id) : [],
      });
    },
    async deleteNotes(e) {
      const id = e?.currentTarget?.dataset?.id;
      const ids = id ? [id] : this.data.selectedNotes;
      if (!ids.length) return;
      const x = await new Promise((resolve) =>
        require('../lib/dialog').show({
          title: ids.length === 1 ? '删除这条通知？' : '删除选中的' + ids.length + '条通知？',
          content: '只移除消息，点菜、换菜和小家记录仍会保留。',
          confirmText: '删除',
          success: resolve,
        }),
      );
      if (!x.confirm) return;
      await api.request('/notifications/delete', { method: 'POST', body: { ids } });
      await loadRequests.call(this);
    },
    async notification(e) {
      const item = this.data.notifications.find((n) => n.id === e.currentTarget.dataset.id);
      if (!item) return;
      await api.request('/notifications/' + item.id + '/read', { method: 'POST', body: {} });
      if (item.type === 'dissolution.complete') {
        require('../lib/dialog').show({ title: '小家消息', content: item.body, showCancel: false });
        await loadRequests.call(this);
        return;
      }
      if (item.type === 'cooking.reminder') {
        go('cookingReminder', { id: item.entity_id, familyId: item.family_id });
        return;
      }
      if (item.type.startsWith('order.')) go('requestDetail', { id: item.entity_id });
      else if (item.type.startsWith('change.')) go('changeDetail', { id: item.entity_id });
      else go('dissolve', { familyId: item.family_id });
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
  const sections = ['早餐', '午餐', '晚餐'].map((slot) => ({
    slot,
    dishes: dishes
      .filter((d) => d.slot === slot)
      .map((d) => ({
        ...d,
        sources: d.sources.map((s) => ({ ...s, pig: identityIndex[s.identity] || 7 })),
        displaySources: require('../lib/orderers')(d.sources).map((s) => ({
          ...s,
          pig: identityIndex[s.identity] || 7,
        })),
        canMark:
          date === require('../lib/dates').today() &&
          session.family.role === 'cook' &&
          (!d.cooker || d.cooker.userId === session.user.id),
        cookedByMe: d.cooker?.userId === session.user.id,
        ownLineId:
          date >= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
            ? d.sources.find((s) => s.userId === session.user.id && !s.done)?.id
            : null,
      })),
  }));
  this.setData({
    date,
    sections,
    total: dishes.length,
    memberCount: [...new Set(dishes.flatMap((d) => d.sources.map((s) => s.userId)))].length,
    quantity: dishes.reduce((n, d) => n + d.quantity, 0),
    isCook: session.family.role === 'cook',
    isToday: date === require('../lib/dates').today(),
  });
}
const todayMethods = {
  async toggleCook(e) {
    const { id, slot } = e.currentTarget.dataset;
    const d = this.data.sections.find((m) => m.slot === slot)?.dishes.find((d) => d.dishId === id);
    if (!d?.canMark) return;
    try {
      await api.request(familyPath('/cooking-claims'), {
        method: 'POST',
        body: { date: this.data.date, slot, dishId: id, done: !d.cooker },
      });
    } catch (error) {
      await loadToday.call(this);
      throw error;
    }
    await loadToday.call(this);
  },
  openRecipe(e) {
    if (session.family.role !== 'cook') return;
    go('recipe', { id: e.currentTarget.dataset.id });
  },
  swapDish(e) {
    go('swap', { id: e.currentTarget.dataset.id });
  },
  async selectDate(e) {
    this.setData({ date: e.currentTarget.dataset.date });
    session.mealDate = this.data.date;
    await loadToday.call(this);
  },
  async month(e) {
    const d = new Date(this.data.date + 'T12:00:00Z');
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + Number(e.currentTarget.dataset.dir));
    this.setData({ date: d.toISOString().slice(0, 10) });
    await loadToday.call(this);
  },
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
exports.calendar = require('./diary');
exports.history = exports.calendar;
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
  data: { source: null, dishes: [], allDishes: [], query: '', selected: '', reason: '' },
  async reload() {
    const lines = await api.request(familyPath('/my-lines'));
    const source = lines.find((l) => l.id === this.query.id);
    if (!source) throw Error('只能更换自己尚未做好的点菜');
    const menu = await api.request(familyPath('/menu'));
    this.setData({
      source: { ...source, cover: await api.image(source.snapshot.coverId) },
      allDishes: await decorate(menu.dishes.filter((d) => d.id !== source.dish_id)),
    });
    this.setData({ dishes: this.data.allDishes.filter((d) => d.name.includes(this.data.query)) });
  },
  methods: {
    search(e) {
      this.setData({
        query: e.detail.value,
        dishes: this.data.allDishes.filter((d) => d.name.includes(e.detail.value)),
      });
    },
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
      go('changeDetail', { id: out.id }, { replace: true });
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
