const { createPage, go, decorate, session, api, familyPath } = require('../lib/page');
exports.shareRecipes = createPage({
  data: { dishes: [], selected: [], all: false },
  async reload() {
    const out = await api.request(familyPath('/menu'));
    if (out.family.role !== 'cook') {
      go('forbidden');
      return;
    }
    this.setData({ dishes: await decorate(out.dishes) });
  },
  methods: {
    select(e) {
      this.setData({
        selected: e.detail.value,
        all: e.detail.value.length === this.data.dishes.length,
      });
    },
    all() {
      const selected = this.data.all ? [] : this.data.dishes.map((d) => d.id);
      this.setData({ selected, all: !this.data.all });
    },
    async submit() {
      if (!this.data.selected.length) throw Error('至少选择一道菜');
      const out = await api.request(familyPath('/shares'), {
        method: 'POST',
        body: { dishIds: this.data.selected },
      });
      session.shareToken = out.token;
      go('recipeParcel', { token: out.token });
    },
  },
});
function parcel(received) {
  return createPage({
    data: { gift: null, received },
    async reload() {
      const token = this.query.token || session.shareToken;
      if (!token) throw Error('这封信还没有封好');
      session.shareToken = token;
      const gift = await api.request('/shares/' + encodeURIComponent(token));
      gift.dishes = await decorate(gift.dishes, token);
      this.setData({ gift, token });
      this.setData({ shareCover: await require('../lib/share-cover')(this, gift.dishes) });
    },
    methods: {
      receive() {
        go('recipeGift', { token: this.data.token });
      },
      save() {
        go('copyRecipes', { token: this.data.token });
      },
    },
    onShareAppMessage() {
      return {
        title: '这几道拿手菜，想请你也尝尝',
        imageUrl: this.data.shareCover || '/assets/recipe-share.png',
        path: '/pages/recipeGift/index?token=' + encodeURIComponent(this.data.token),
      };
    },
  });
}
exports.recipeParcel = parcel(false);
exports.recipeGift = parcel(true);
exports.copyRecipes = createPage({
  data: {
    homes: [],
    target: '',
    newName: '',
    mode: 'add',
    scope: 'matching',
    showConfirm: false,
    preview: null,
  },
  async reload() {
    session.shareToken = this.query.token || session.shareToken;
    const [homes, gift] = await Promise.all([
      api.request('/families'),
      api.request('/shares/' + encodeURIComponent(session.shareToken)),
    ]);
    this.setData({
      homes,
      gift,
      target: this.data.target || homes.find((h) => h.role === 'cook')?.id || 'new',
    });
  },
  methods: {
    target(e) {
      this.setData({ target: e.currentTarget.dataset.id });
    },
    mode(e) {
      this.setData({ mode: e.currentTarget.dataset.mode });
    },
    scope(e) {
      this.setData({ scope: e.currentTarget.dataset.scope });
    },
    async preview() {
      const body = importBody(this.data);
      const preview = await api.request('/imports/preview', { method: 'POST', body });
      this.setData({ preview, showConfirm: true });
    },
    close() {
      this.setData({ showConfirm: false });
    },
    async commit() {
      const body = { ...importBody(this.data), version: this.data.preview.version };
      const receipt = await api.request('/imports', { method: 'POST', body });
      session.copyReceipt = { ...receipt, name: this.data.preview.target };
      this.setData({ showConfirm: false });
      go('copyDone');
    },
  },
});
function importBody(d) {
  return {
    token: session.shareToken,
    ...(d.target === 'new' ? { newFamilyName: d.newName } : { familyId: d.target }),
    mode: d.mode,
    scope: d.scope,
  };
}
exports.copyDone = createPage({
  data: { receipt: null },
  async reload() {
    this.setData({ receipt: session.copyReceipt });
  },
  methods: {
    async open() {
      const homes = await api.request('/families');
      const home = homes.find((h) => h.id === this.data.receipt.familyId);
      if (!home) throw Error('目标小家暂时不可用');
      session.setFamily(home);
      go('manage', {}, { replace: true });
    },
  },
});
