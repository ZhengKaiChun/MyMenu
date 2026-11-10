const { createPage, go, decorate, familyPath, session, api } = require('../lib/page');
function count() {
  return Object.values(session.cart).reduce((n, x) => n + x, 0);
}
function cartRows(dishes) {
  return dishes
    .filter((d) => session.cart[d.id])
    .map((d) => ({ ...d, quantity: session.cart[d.id] }));
}
function filterMenu(page) {
  const list = page.data.allDishes.filter(
    (d) =>
      (page.data.category === 'all' || d.collectionId === page.data.category) &&
      d.name.includes(page.data.search || ''),
  );
  page.setData({
    dishes: list,
    count: count(),
    cart: cartRows(page.data.allDishes),
    quantities: { ...session.cart },
    categoryName:
      page.data.collections.find((c) => c.id === page.data.category)?.name || '全部菜品',
  });
}
exports.menu = createPage({
  data: {
    allDishes: [],
    dishes: [],
    collections: [],
    category: 'all',
    search: '',
    count: 0,
    date: '',
    slot: '晚餐',
    showCart: false,
  },
  async reload() {
    const out = await api.request(familyPath('/menu'));
    session.family = { ...session.family, ...out.family };
    this.setData({
      family: session.family,
      collections: out.collections,
      allDishes: await decorate(out.dishes),
      date: this.data.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    });
    filterMenu(this);
  },
  methods: {
    category(e) {
      this.setData({ category: e.currentTarget.dataset.id });
      filterMenu(this);
    },
    search(e) {
      this.setData({ search: e.detail.value });
      filterMenu(this);
    },
    date(e) {
      this.setData({ date: e.detail.value });
      session.mealDate = e.detail.value;
    },
    meal(e) {
      this.setData({ slot: e.currentTarget.dataset.slot });
      session.mealSlot = this.data.slot;
    },
    add(e) {
      const id = e.currentTarget.dataset.id;
      session.cart[id] = Math.min(99, (session.cart[id] || 0) + 1);
      filterMenu(this);
    },
    minus(e) {
      const id = e.currentTarget.dataset.id;
      session.cart[id] = Math.max(0, (session.cart[id] || 0) - 1);
      if (!session.cart[id]) delete session.cart[id];
      filterMenu(this);
    },
    cart() {
      this.setData({ showCart: !this.data.showCart });
    },
    checkout() {
      if (!count()) throw Error('先选一道想吃的菜吧');
      session.mealDate = this.data.date;
      session.mealSlot = this.data.slot;
      go('checkout');
    },
  },
});
exports.dish = createPage({
  data: { dish: null },
  async reload() {
    const out = await api.request(familyPath('/menu')),
      dish = out.dishes.find((d) => d.id === this.query.id);
    if (!dish) throw Error('这道菜暂时不在菜单里');
    this.setData({ dish: (await decorate([dish]))[0], isCook: out.family.role === 'cook' });
  },
  methods: {
    add() {
      session.cart[this.data.dish.id] = Math.min(99, (session.cart[this.data.dish.id] || 0) + 1);
      wx.showToast({ title: '已放进菜篮', icon: 'none' });
    },
    recipe() {
      go('recipe', { id: this.data.dish.id });
    },
  },
});
async function manageLoad() {
  const out = await api.request(familyPath('/menu'));
  if (out.family.role !== 'cook') {
    go('forbidden');
    return;
  }
  this.setData({
    family: out.family,
    collections: out.collections,
    allDishes: await decorate(out.dishes),
  });
  filterMenu(this);
}
const manageMethods = {
  category(e) {
    this.setData({ category: e.currentTarget.dataset.id });
    filterMenu(this);
  },
  async addCollection() {
    const result = await new Promise((resolve) =>
      wx.showModal({
        title: '新建菜单合集',
        editable: true,
        placeholderText: '比如：下饭拿手菜',
        success: resolve,
      }),
    );
    if (result.confirm && result.content) {
      await api.request(familyPath('/collections'), {
        method: 'POST',
        body: { name: result.content },
      });
      await manageLoad.call(this);
    }
  },
  async renameCollection(e) {
    const id = e.currentTarget.dataset.id;
    const result = await new Promise((resolve) =>
      wx.showModal({ title: '编辑合集名称', editable: true, success: resolve }),
    );
    if (result.confirm && result.content) {
      await api.request(familyPath('/collections/' + id), {
        method: 'PATCH',
        body: { name: result.content },
      });
      await manageLoad.call(this);
    }
  },
  async deleteCollection(e) {
    const answer = await new Promise((resolve) =>
      wx.showModal({
        title: '删除这个合集？',
        content: '有菜品的合集请先移动菜品。',
        success: resolve,
      }),
    );
    if (answer.confirm) {
      await api.request(familyPath('/collections/' + e.currentTarget.dataset.id), {
        method: 'DELETE',
      });
      this.setData({ category: 'all' });
      await manageLoad.call(this);
    }
  },
  async remove(e) {
    const answer = await new Promise((resolve) =>
      wx.showModal({
        title: '删除这道菜？',
        content: '将从点菜菜单移除，已点餐次及历史记录保留。',
        success: resolve,
      }),
    );
    if (answer.confirm) {
      await api.request(familyPath('/dishes/' + e.currentTarget.dataset.id), { method: 'DELETE' });
      await manageLoad.call(this);
    }
  },
  async move(e) {
    const { id, dir, type } = e.currentTarget.dataset,
      list = type === 'collections' ? this.data.collections : this.data.allDishes,
      ids = list.map((d) => d.id),
      i = ids.indexOf(id),
      j = i + Number(dir);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.request(familyPath('/sort'), {
      method: 'POST',
      body: { type: type || 'dishes', ids },
    });
    await manageLoad.call(this);
  },
  dragStart(e) {
    this.drag = {
      id: e.currentTarget.dataset.id,
      type: e.currentTarget.dataset.type || 'dishes',
      y: e.touches[0].clientY,
    };
  },
  async dragEnd(e) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    const rows = drag.type === 'collections' ? this.data.collections : this.data.allDishes,
      ids = rows.map((x) => x.id),
      from = ids.indexOf(drag.id),
      delta = Math.round(
        (e.changedTouches[0].clientY - drag.y) / (drag.type === 'collections' ? 98 : 144),
      ),
      to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from < 0 || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    await api.request(familyPath('/sort'), { method: 'POST', body: { type: drag.type, ids } });
    await manageLoad.call(this);
  },
};
exports.manage = createPage({
  data: { allDishes: [], dishes: [], collections: [], category: 'all', search: '' },
  reload: manageLoad,
  methods: manageMethods,
});
exports.collections = exports.manage;
exports.editDish = createPage({
  data: {
    name: '',
    intro: '',
    minutes: 15,
    servings: 2,
    collectionId: '',
    collections: [],
    coverId: null,
    cover: '',
    ingredients: [{ name: '', quantity: 1, unit: '个' }],
    steps: [{ text: '', imageId: null }],
    version: null,
  },
  async reload() {
    if (this.loaded) return;
    const menu = await api.request(familyPath('/menu'));
    if (menu.family.role !== 'cook') {
      go('forbidden');
      return;
    }
    this.setData({
      collections: menu.collections,
      collectionId: menu.collections[0]?.id || '',
      collectionName: menu.collections[0]?.name || '',
    });
    if (this.query.id) {
      const d = await api.request(familyPath('/dishes/' + this.query.id + '/recipe'));
      this.setData({
        ...d,
        collectionName: menu.collections.find((c) => c.id === d.collectionId)?.name || '',
        cover: d.coverId ? await api.image(d.coverId, '') : '',
        steps: await Promise.all(
          d.steps.map(async (s) => ({
            ...s,
            image: s.imageId ? await api.image(s.imageId, '') : '',
          })),
        ),
      });
    }
    this.loaded = true;
  },
  methods: {
    collection(e) {
      this.setData({
        collectionId: this.data.collections[Number(e.detail.value)].id,
        collectionName: this.data.collections[Number(e.detail.value)].name,
      });
    },
    field(e) {
      const { list, index, field } = e.currentTarget.dataset;
      this.setData({
        [list + '[' + index + '].' + field]:
          field === 'quantity' ? Number(e.detail.value) : e.detail.value,
      });
      if (wx.enableAlertBeforeUnload)
        wx.enableAlertBeforeUnload({ message: '菜谱还没有保存，要离开吗？' });
    },
    addIngredient() {
      this.setData({
        ingredients: [...this.data.ingredients, { name: '', quantity: 1, unit: '个' }],
      });
    },
    removeIngredient(e) {
      const ingredients = this.data.ingredients.filter(
        (_, i) => i !== Number(e.currentTarget.dataset.index),
      );
      this.setData({ ingredients });
    },
    addStep() {
      this.setData({ steps: [...this.data.steps, { text: '', imageId: null }] });
    },
    removeStep(e) {
      if (this.data.steps.length <= 1) throw Error('至少保留一步制作说明');
      this.setData({
        steps: this.data.steps.filter((_, i) => i !== Number(e.currentTarget.dataset.index)),
      });
    },
    async picture(e) {
      const picked = await new Promise((resolve, reject) =>
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sizeType: ['compressed'],
          success: resolve,
          fail: reject,
        }),
      );
      const out = await api.upload(picked.tempFiles[0].tempFilePath);
      const url = await api.image(out.id, '');
      if (e.currentTarget.dataset.kind === 'cover') this.setData({ coverId: out.id, cover: url });
      else {
        const i = Number(e.currentTarget.dataset.index);
        this.setData({ ['steps[' + i + '].imageId']: out.id, ['steps[' + i + '].image']: url });
      }
    },
    ai() {
      wx.showToast({ title: '图片优化功能尚未启用', icon: 'none' });
    },
    async save() {
      const d = this.data;
      const body = {
        name: d.name,
        intro: d.intro,
        collectionId: d.collectionId,
        coverId: d.coverId || null,
        minutes: Number(d.minutes),
        servings: Number(d.servings),
        ingredients: d.ingredients.map((i) => ({
          name: i.name,
          quantity: Number(i.quantity),
          unit: i.unit,
        })),
        steps: d.steps.map((s) => ({ text: s.text, imageId: s.imageId || null })),
        ...(d.version ? { version: d.version } : {}),
      };
      await api.request(familyPath('/dishes' + (this.query.id ? '/' + this.query.id : '')), {
        method: this.query.id ? 'PUT' : 'POST',
        body,
      });
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      wx.redirectTo({ url: '/pages/manage/index' });
    },
  },
});
exports.recipe = createPage({
  data: { dish: null, textOnly: false },
  async reload() {
    const d = await api.request(familyPath('/dishes/' + this.query.id + '/recipe'));
    this.setData({
      dish: {
        ...d,
        cover: await api.image(d.coverId),
        steps: await Promise.all(
          d.steps.map(async (s) => ({
            ...s,
            image: s.imageId ? await api.image(s.imageId, '') : '',
          })),
        ),
      },
    });
  },
  methods: {
    toggle() {
      this.setData({ textOnly: !this.data.textOnly });
    },
  },
});
