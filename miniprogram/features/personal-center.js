const { createPage, api, go, session, decorate, familyPath } = require('../lib/page');
const dates = require('../lib/dates');
exports.accountSecurity = createPage({
  data: { username: '', currentPassword: '', newPassword: '', confirm: '', security: {} },
  async reload() {
    if (this.loaded) return;
    const security = await api.request('/me/security');
    this.setData({ security, username: security.username });
    this.loaded = true;
  },
  dispose() {
    this.data.currentPassword = '';
    this.data.newPassword = '';
    this.data.confirm = '';
  },
  methods: {
    async submit() {
      const d = this.data;
      if (d.newPassword !== d.confirm) throw Error('两次输入的新密码不一致');
      const body = {
        username: d.username,
        currentPassword: d.currentPassword,
        ...(d.newPassword ? { newPassword: d.newPassword } : {}),
      };
      const out = await api.request('/me/credentials', { method: 'POST', body });
      session.saveAuth(out);
      this.setData({ currentPassword: '', newPassword: '', confirm: '' });
      wx.showToast({ title: '账号已更新', icon: 'none' });
      go('settings', {}, { replace: true });
    },
  },
});
exports.achievements = createPage({
  data: { cooked: 0, ordered: 0, families: [] },
  async reload() {
    this.setData(await api.request('/me/achievements'));
  },
  methods: {
    record(e) {
      go('cookingRecord', { familyId: e.currentTarget.dataset.id });
    },
  },
});
async function loadCooking() {
  const [menu, record] = await Promise.all([
    api.request(familyPath('/meals') + '?date=' + this.data.date),
    api.request(
      familyPath('/cooking-records') +
        '?date=' +
        this.data.date +
        '&slot=' +
        encodeURIComponent(this.data.slot),
    ),
  ]);
  const dishes = await decorate(
    menu.dishes
      .filter((d) => d.slot === this.data.slot)
      .map((d) => ({ ...d.snapshot, id: d.dishId })),
  );
  this.setData({
    dishes,
    selected: record.dishIds,
    all: dishes.length > 0 && dishes.every((d) => record.dishIds.includes(d.id)),
  });
}
exports.cookingRecord = createPage({
  data: {
    date: dates.today(),
    minDate: dates.bounds().min,
    maxDate: dates.today(),
    slot: '晚餐',
    dishes: [],
    selected: [],
    all: false,
  },
  async reload() {
    if (session.family?.role !== 'cook') {
      go('forbidden');
      return;
    }
    await loadCooking.call(this);
  },
  methods: {
    async date(e) {
      this.setData({ date: e.detail.value });
      await loadCooking.call(this);
    },
    async meal(e) {
      this.setData({ slot: e.currentTarget.dataset.slot });
      await loadCooking.call(this);
    },
    select(e) {
      const selected = e.detail.value;
      this.setData({
        selected,
        all: this.data.dishes.length > 0 && this.data.dishes.every((d) => selected.includes(d.id)),
      });
    },
    all() {
      const all = !this.data.all;
      this.setData({ all, selected: all ? this.data.dishes.map((d) => d.id) : [] });
    },
    async submit() {
      await api.request(familyPath('/cooking-records'), {
        method: 'PUT',
        body: { date: this.data.date, slot: this.data.slot, dishIds: this.data.selected },
      });
      wx.showToast({ title: '掌勺记录已保存', icon: 'none' });
      go('achievements', {}, { replace: true });
    },
  },
});
