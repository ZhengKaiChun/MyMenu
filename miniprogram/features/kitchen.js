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
function syncDraft(page) {
  const d = session.menuDraft;
  page.setData({
    family: d.family,
    collections: d.collections,
    allDishes: d.dishes,
    dirty: d.dirty,
  });
  filterMenu(page);
}
async function manageLoad() {
  if (!session.menuDraft || session.menuDraft.family.id !== session.family.id) {
    const out = await api.request(familyPath('/menu'));
    if (out.family.role !== 'cook') {
      go('forbidden');
      return;
    }
    session.menuDraft = {
      family: out.family,
      version: out.family.version,
      collections: out.collections,
      dishes: await decorate(out.dishes),
      recipes: {},
      deleted: [],
      dirty: false,
    };
  }
  syncDraft(this);
}
function changed(page) {
  session.menuDraft.dirty = true;
  syncDraft(page);
  if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '菜单修改尚未保存' });
}
const manageMethods = {
  category(e) {
    this.setData({ category: e.currentTarget.dataset.id });
    filterMenu(this);
  },
  async addCollection() {
    const x = await new Promise((resolve) =>
      require('../lib/dialog').show({ title: '新建合集', editable: true, success: resolve }),
    );
    if (x.confirm && x.content?.trim()) {
      session.menuDraft.collections.push({ id: 'draft-' + api.uuid(), name: x.content.trim() });
      changed(this);
    }
  },
  async renameCollection(e) {
    const c = session.menuDraft.collections.find((c) => c.id === e.currentTarget.dataset.id);
    const x = await new Promise((resolve) =>
      require('../lib/dialog').show({
        title: '合集名称',
        editable: true,
        content: c.name,
        success: resolve,
      }),
    );
    if (x.confirm && x.content?.trim()) {
      c.name = x.content.trim();
      changed(this);
    }
  },
  async deleteCollection(e) {
    const id = e.currentTarget.dataset.id;
    if (session.menuDraft.dishes.some((d) => d.collectionId === id))
      throw Error('先把合集中的菜移到其他合集');
    if (session.menuDraft.collections.length < 2) throw Error('至少保留一个合集');
    const x = await new Promise((resolve) =>
      require('../lib/dialog').show({
        title: '删除这个合集？',
        content: '点击总保存后才会生效。',
        success: resolve,
      }),
    );
    if (x.confirm) {
      session.menuDraft.collections = session.menuDraft.collections.filter((c) => c.id !== id);
      this.setData({ category: 'all' });
      changed(this);
    }
  },
  async remove(e) {
    const id = e.currentTarget.dataset.id;
    const x = await new Promise((resolve) =>
      require('../lib/dialog').show({
        title: '删除这道菜？',
        content: '保存菜单后才会移除，历史点餐仍保留。',
        success: resolve,
      }),
    );
    if (x.confirm) {
      session.menuDraft.dishes = session.menuDraft.dishes.filter((d) => d.id !== id);
      session.menuDraft.deleted.push(id);
      delete session.menuDraft.recipes[id];
      changed(this);
    }
  },
  async moveCollection(e) {
    const id = e.currentTarget.dataset.id;
    const choices = session.menuDraft.collections;
    const x = await new Promise((resolve, reject) =>
      wx.showActionSheet({ itemList: choices.map((c) => c.name), success: resolve, fail: reject }),
    );
    const d = session.menuDraft.dishes.find((d) => d.id === id);
    d.collectionId = choices[x.tapIndex].id;
    if (session.menuDraft.recipes[id]) session.menuDraft.recipes[id].collectionId = d.collectionId;
    changed(this);
  },
  move(e) {
    const { id, dir, type } = e.currentTarget.dataset;
    const list = type === 'collections' ? session.menuDraft.collections : session.menuDraft.dishes;
    const i = list.findIndex((x) => x.id === id),
      j = i + Number(dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    changed(this);
  },
  dragStart(e) {
    this.drag = {
      id: e.currentTarget.dataset.id,
      type: e.currentTarget.dataset.type || 'dishes',
      y: e.touches[0].clientY,
    };
  },
  dragEnd(e) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    const list =
      d.type === 'collections' ? session.menuDraft.collections : session.menuDraft.dishes;
    const from = list.findIndex((x) => x.id === d.id),
      to = Math.max(
        0,
        Math.min(list.length - 1, from + Math.round((e.changedTouches[0].clientY - d.y) / 110)),
      );
    if (from !== to) {
      list.splice(to, 0, list.splice(from, 1)[0]);
      changed(this);
    }
  },
  async saveMenu() {
    const d = session.menuDraft;
    this.setData({saving:true});
    try { await api.request(familyPath('/menu-layout'), {
      method: 'PUT',
      body: {
        version: d.version,
        collections: d.collections.map((c) => ({ id: c.id, name: c.name })),
        dishes: d.dishes.map((x) => ({ id: x.id, collectionId: x.collectionId })),
        deletedDishIds: d.deleted.filter((id) => !id.startsWith('draft-')),
        recipes: Object.entries(d.recipes).map(([id, body]) => ({ id, body })),
      },
    });
    } finally {this.setData({saving:false});}
    session.menuDraft = null;
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    await manageLoad.call(this);
    wx.showToast({ title: '菜单已保存' });
  },
  async discard() {
    session.menuDraft = null;
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    await manageLoad.call(this);
  },
};
exports.manage = createPage({
  data: { allDishes: [], dishes: [], collections: [], category: 'all', search: '', dirty: false },
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
    this.setData({inDraft:!!session.menuDraft});
    const menu = session.menuDraft
      ? { family: session.menuDraft.family, collections: session.menuDraft.collections }
      : await api.request(familyPath('/menu'));
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
      const d =
        session.menuDraft?.recipes[this.query.id] ||
        (await api.request(familyPath('/dishes/' + this.query.id + '/recipe')));
      const moved = session.menuDraft?.dishes.find((x) => x.id === this.query.id);
      if (moved) d.collectionId = moved.collectionId;
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
      this.data[list][Number(index)][field] =
        field === 'quantity' ? Number(e.detail.value) : e.detail.value;
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
        ingredients: d.ingredients
          .filter((i) => i.name.trim())
          .map((i) => ({
            name: i.name,
            quantity: Number(i.quantity),
            unit: i.unit,
          })),
        steps: d.steps
          .filter((s) => s.text.trim())
          .map((s) => ({ text: s.text, imageId: s.imageId || null })),
        ...(d.version ? { version: d.version } : {}),
      };
      if (session.menuDraft) {
        if (!body.name.trim()) throw Error('请填写菜名');
        const id = this.query.id || 'draft-' + api.uuid();
        session.menuDraft.recipes[id] = body;
        const row = { ...body, id, cover: d.cover };
        const index = session.menuDraft.dishes.findIndex((x) => x.id === id);
        if (index < 0) session.menuDraft.dishes.push(row);
        else session.menuDraft.dishes[index] = row;
        session.menuDraft.dirty = true;
        if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
        wx.navigateBack();
        return;
      }
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
