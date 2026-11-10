const { createPage, go, session, api, familyPath, decorate } = require('../lib/page');
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
        isCook: personal || session.family?.role === 'cook',
      });
      this.setData({ items: this.data.allItems.filter((i) => i.name.includes(this.data.query)) });
    },
    methods: {
      search(e) {
        this.setData({
          query: e.detail.value,
          items: this.data.allItems.filter((i) => i.name.includes(e.detail.value)),
        });
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
        this.setData({ personalItems: await api.request('/inventory'), showImport: true });
      },
      closeImport() {
        this.setData({ showImport: false });
      },
      selectImport(e) {
        this.setData({ importIds: e.detail.value });
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
      wx.navigateBack();
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
