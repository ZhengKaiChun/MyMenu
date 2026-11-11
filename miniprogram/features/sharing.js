const { createPage, go, decorate, session, api, familyPath } = require('../lib/page');
function filterShare(page) {
  const dishes = page.data.allDishes.filter(
    (d) =>
      (page.data.category === 'all' || d.collectionId === page.data.category) &&
      d.name.includes(page.data.query || ''),
  );
  page.setData({
    dishes,
    all: dishes.length > 0 && dishes.every((d) => page.data.selected.includes(d.id)),
  });
}
exports.shareRecipes = createPage({
  data: {
    dishes: [],
    allDishes: [],
    collections: [],
    category: 'all',
    query: '',
    selected: [],
    all: false,
  },
  async reload() {
    const out = await api.request(familyPath('/menu'));
    if (out.family.role !== 'cook') {
      go('forbidden');
      return;
    }
    this.setData({ allDishes: await decorate(out.dishes), collections: out.collections });
    filterShare(this);
  },
  methods: {
    search(e) {
      this.setData({ query: e.detail.value });
      filterShare(this);
    },
    category(e) {
      this.setData({ category: e.currentTarget.dataset.id });
      filterShare(this);
    },
    select(e) {
      const ids = this.data.dishes.map((d) => d.id);
      this.setData({
        selected: [...this.data.selected.filter((id) => !ids.includes(id)), ...e.detail.value],
      });
      filterShare(this);
    },
    all() {
      const ids = this.data.dishes.map((d) => d.id),
        keep = this.data.selected.filter((id) => !ids.includes(id));
      this.setData({ selected: this.data.all ? keep : [...keep, ...ids] });
      filterShare(this);
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
