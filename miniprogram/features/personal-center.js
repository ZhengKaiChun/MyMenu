const { createPage, api, go, session, familyPath } = require('../lib/page');
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
      go('today', { familyId: e.currentTarget.dataset.id });
    },
  },
});
// Keep older entry links pointed at the daily menu.
exports.cookingRecord = createPage({
  async reload() {
    go('today', this.query, { replace: true });
  },
});
exports.cookingReminder = createPage({
  data: { reminder: null },
  async reload() {
    const r = await api.request(familyPath('/cooking-reminders/') + this.query.id);
    this.setData({ reminder: { ...r, cover: await api.image(r.coverId) } });
  },
  methods: {
    async claim() {
      const r = this.data.reminder;
      if (!r?.claimable) return;
      try {
        await api.request(familyPath('/cooking-claims'), {
          method: 'POST',
          body: { date: r.date, slot: r.slot, dishId: r.dishId, done: true },
        });
      } catch (error) {
        await this.onShow();
        throw error;
      }
      await this.onShow();
      wx.showToast({ title: '已记为你做的', icon: 'none' });
    },
    notMine() {
      go('requests', {}, { replace: true });
    },
  },
});
