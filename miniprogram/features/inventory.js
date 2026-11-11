const { createPage, go, session, api, familyPath, decorate } = require('../lib/page');
function inventoryGroups(page) {
  const names = ['蔬菜', '肉禽', '蛋奶', '海鲜', '主食', '调味', '其他'];
  page.setData({
    groups: names
      .map((name) => ({
        name,
        items: page.data.items.filter(
          (i) => (names.includes(i.category) ? i.category : '其他') === name,
        ),
      }))
      .filter((g) => g.items.length),
  });
}
function importGroups(page) {
  const names = ['蔬菜', '肉禽', '蛋奶', '海鲜', '主食', '调味', '其他'];
  const all = page.data.personalItems;
  const filtered = all.filter(
    (i) =>
      (page.data.importCategory === 'all' || i.category === page.data.importCategory) &&
      i.name.includes(page.data.importQuery),
  );
  const sections = names
    .map((name) => ({ name, items: filtered.filter((i) => i.category === name) }))
    .filter((g) => g.items.length);
  page.setData({
    importHeight: Math.max(
      90,
      sections.reduce((sum, g) => sum + 32 + Math.ceil(g.items.length / 2) * 69, 0),
    ),
    importGroups: names
      .map((name) => ({ name, items: filtered.filter((i) => i.category === name) }))
      .filter((g) => g.items.length),
    importTabs: [
      { id: 'all', name: '全部', count: all.length },
      ...names
        .map((name) => ({ id: name, name, count: all.filter((i) => i.category === name).length }))
        .filter((t) => t.count),
    ],
    importVisible: filtered.map((i) => i.id),
    importAll: filtered.length > 0 && filtered.every((i) => page.data.importIds.includes(i.id)),
  });
}
function inventoryPage(personal) {
  return createPage({
    data: {
      items: [],
      allItems: [],
      query: '',
      personal,
      isCook: false,
      showImport: false,
      personalItems: [],
      importIds: [],
    },
    async reload() {
      const path = personal ? '/inventory' : familyPath('/inventory');
      const items = await api.request(path);
      this.setData({
        allItems: items.map((i) => ({
          ...i,
          icon: { 番茄: 'tomato', 鸡蛋: 'egg', 牛奶: 'milk', 西兰花: 'leaf' }[i.name] || 'basket',
        })),
        isCook: true,
        canMatch: session.family?.role === 'cook',
      });
      this.setData({ items: this.data.allItems.filter((i) => i.name.includes(this.data.query)) });
      inventoryGroups(this);
    },
    methods: {
      search(e) {
        this.setData({
          query: e.detail.value,
          items: this.data.allItems.filter((i) => i.name.includes(e.detail.value)),
        });
        inventoryGroups(this);
      },
      add() {
        go('ingredientEdit', { scope: personal ? 'personal' : 'family' });
      },
      edit(e) {
        const item = this.data.items.find((i) => i.id === e.currentTarget.dataset.id);
        session.editIngredient = item;
        go('ingredientEdit', { scope: personal ? 'personal' : 'family' });
      },
      async remove(e) {
        await api.request(
          (personal ? '/inventory' : familyPath('/inventory')) + '/' + e.currentTarget.dataset.id,
          { method: 'DELETE' },
        );
        await this.onShow();
      },
      async showImport() {
        const items = await api.request('/inventory');
        const names = ['蔬菜', '肉禽', '蛋奶', '海鲜', '主食', '调味', '其他'];
        this.setData({
          personalItems: items.map((i) => ({
            ...i,
            category: names.includes(i.category) ? i.category : '其他',
          })),
          showImport: true,
          importIds: [],
          importQuery: '',
          importCategory: 'all',
        });
        importGroups(this);
      },
      closeImport() {
        this.setData({ showImport: false });
      },
      importSearch(e) {
        this.setData({ importQuery: e.detail.value });
        importGroups(this);
      },
      importCategory(e) {
        this.setData({ importCategory: e.currentTarget.dataset.id });
        importGroups(this);
      },
      selectImport(e) {
        this.setData({
          importIds: [
            ...this.data.importIds.filter((id) => !this.data.importVisible.includes(id)),
            ...e.detail.value,
          ],
        });
        importGroups(this);
      },
      allImport() {
        const keep = this.data.importIds.filter((id) => !this.data.importVisible.includes(id));
        this.setData({
          importIds: this.data.importAll ? keep : [...keep, ...this.data.importVisible],
        });
        importGroups(this);
      },
      async importItems() {
        await api.request(familyPath('/inventory/import'), {
          method: 'POST',
          body: { ids: this.data.importIds },
        });
        this.setData({ showImport: false });
        await this.onShow();
      },
    },
  });
}
exports.pantry = inventoryPage(false);
exports.personal = inventoryPage(true);
exports.ingredientEdit = createPage({
  data: {
    name: '',
    quantity: '',
    unit: '个',
    category: '蔬菜',
    categories: ['蔬菜', '肉禽', '蛋奶', '调味', '其他'],
    scope: 'family',
  },
  init(q) {
    const item = session.editIngredient;
    session.editIngredient = null;
    this.setData({ scope: q.scope || 'family', ...(item || {}) });
  },
  methods: {
    category(e) {
      this.setData({ category: this.data.categories[Number(e.detail.value)] });
    },
    async save() {
      const d = this.data;
      await api.request(
        (d.scope === 'personal' ? '/inventory' : familyPath('/inventory')) +
          (d.id ? '/' + d.id : ''),
        {
          method: d.id ? 'PUT' : 'POST',
          body: {
            name: d.name,
            quantity: Number(d.quantity),
            unit: d.unit,
            category: d.category,
            ...(d.id ? { version: d.version } : {}),
          },
        },
      );
      go(this.data.scope === 'personal' ? 'personal' : 'pantry', {}, { replace: true });
    },
  },
});
exports.match = createPage({
  data: { query: '', results: [] },
  async reload() {
    this.setData({
      results: await decorate(
        await api.request(
          familyPath('/match') + '?ingredients=' + encodeURIComponent(this.data.query),
        ),
      ),
    });
  },
  methods: {
    async search() {
      await this.onShow();
    },
  },
});
exports.shopping = createPage({
  data: { items: [], date: '', dishes: [] },
  async reload() {
    const date =
      this.query.date ||
      session.mealDate ||
      new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const [items, meal] = await Promise.all([
      api.request(familyPath('/prep') + '?date=' + date),
      api.request(familyPath('/meals') + '?date=' + date),
    ]);
    this.setData({
      date,
      items,
      dishes: meal.dishes,
      ready: items.filter((i) => i.checked).length,
    });
  },
  methods: {
    async change(e) {
      const i = Number(e.currentTarget.dataset.index);
      const items = this.data.items.map((item, index) => ({
        ...item,
        checked: index === i ? !item.checked : item.checked,
      }));
      await savePrep.call(this, items);
    },
    async owned() {
      await savePrep.call(
        this,
        this.data.items.map((i) => ({ ...i, checked: i.owned || i.checked })),
      );
    },
    async none() {
      await savePrep.call(
        this,
        this.data.items.map((i) => ({ ...i, checked: false })),
      );
    },
    async all() {
      await savePrep.call(
        this,
        this.data.items.map((i) => ({ ...i, checked: true })),
      );
    },
  },
});
async function savePrep(items) {
  await api.request(familyPath('/prep'), {
    method: 'PUT',
    body: {
      date: this.data.date,
      items: items.map((i) => ({ name: i.name, unit: i.unit, checked: i.checked })),
    },
  });
  this.setData({ items, ready: items.filter((i) => i.checked).length });
}
