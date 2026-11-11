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
          status: labels[order?.status || change?.status] || '',
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
  if (this.historyOnly)
    dishes = dishes
      .map((d) => ({
        ...d,
        sources: d.sources.filter(
          (s) => s.done || date < new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
        ),
      }))
      .filter((d) => d.sources.length)
      .map((d) => ({ ...d, quantity: d.sources.reduce((n, s) => n + s.quantity, 0) }));
  const sections = ['早餐', '午餐', '晚餐'].map((slot) => ({
    slot,
    dishes: dishes
      .filter((d) => d.slot === slot)
      .map((d) => ({
        ...d,
        sources: d.sources.map((s) => ({ ...s, pig: identityIndex[s.identity] || 7 })),
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
  });
  if (this.calendarPage || this.historyOnly) {
    const selected = new Date(date + 'T12:00:00+08:00'),
      year = selected.getUTCFullYear(),
      month = selected.getUTCMonth();
    const start = new Date(Date.UTC(year, month, 1)),
      end = new Date(Date.UTC(year, month + 1, 0));
    const first = start.toISOString().slice(0, 10),
      last = end.toISOString().slice(0, 10);
    const days = await api.request(
      familyPath('/meal-dates') +
        '?from=' +
        first +
        '&to=' +
        last +
        (this.historyOnly ? '&done=1' : ''),
    );
    const dots = days.map((x) => x.date),
      offset = (start.getUTCDay() + 6) % 7;
    const cells = [
      ...Array.from({ length: offset }, (_, i) => ({ id: 'blank-' + i, blank: true })),
      ...Array.from({ length: end.getUTCDate() }, (_, i) => {
        const value =
          year + '-' + String(month + 1).padStart(2, '0') + '-' + String(i + 1).padStart(2, '0');
        return {
          id: value,
          date: value,
          day: i + 1,
          on: value === date,
          dot: dots.includes(value),
        };
      }),
    ];
    const beginning = new Date(selected);
    beginning.setUTCDate(beginning.getUTCDate() - ((beginning.getUTCDay() + 6) % 7));
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(beginning);
      d.setUTCDate(d.getUTCDate() + i);
      const value = d.toISOString().slice(0, 10);
      return {
        date: value,
        day: d.getUTCDate(),
        label:
          value === new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
            ? '今天'
            : ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][i],
        on: value === date,
      };
    });
    this.setData({
      calendarYear: year,
      calendarMonth: month + 1,
      calendarDay: selected.getUTCDate(),
      cells,
      weekDays,
      weekLabels: ['一', '二', '三', '四', '五', '六', '日'],
    });
  }
}
const todayMethods = {
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
exports.calendar = createPage({
  data: { date: '', sections: [], weekDays: [] },
  init() {
    this.calendarPage = true;
  },
  reload: loadToday,
  methods: todayMethods,
});
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
