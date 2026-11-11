const { createPage, go, decorate, familyPath, session, api } = require('../lib/page');
const groups = require('../lib/collections');
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
      ((page.data.isOrdering && (page.data.search || '').trim()) ||
        page.data.category === 'all' ||
        groups.contains(d, page.data.category)) &&
      d.name.includes(page.data.search || '') &&
      (!page.data.isOrdering ||
        !page.data.showMeatTabs ||
        (page.data.search || '').trim() ||
        !page.data.meatType ||
        (d.meatType || '其他') === page.data.meatType),
  );
  page.setData({
    dishes: list,
    count: count(),
    cart: cartRows(page.data.allDishes),
    quantities: { ...session.cart },
    categoryName:
      page.data.isOrdering && (page.data.search || '').trim()
        ? '搜索结果'
        : page.data.collections.find((c) => c.id === page.data.category)?.name || '全部菜品',
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
    isOrdering: true,
    meatType: '',
    meatTypes: require('../lib/inventory-types').meatTypes,
    showMeatTabs: false,
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
    if (!out.collections.some((c) => c.id === this.data.category))
      this.setData({ category: out.collections[0]?.id || '' });
    this.setData({
      showMeatTabs: ['肉类', '肉禽', '荤菜'].includes(
        out.collections.find((c) => c.id === this.data.category)?.name,
      ),
    });
    filterMenu(this);
  },
  methods: {
    meatCategory(e) {
      const type = e.currentTarget.dataset.type;
      this.setData({ meatType: this.data.meatType === type ? '' : type });
      filterMenu(this);
    },
    category(e) {
      const id = e.currentTarget.dataset.id;
      const showMeatTabs = ['肉类', '肉禽', '荤菜'].includes(
        this.data.collections.find((c) => c.id === id)?.name,
      );
      this.setData({ category: id, showMeatTabs, meatType: '' });
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
  if (!d.collections.some((c) => c.id === page.data.category))
    page.setData({ category: d.collections[0]?.id || '' });
  filterMenu(page);
}
function rememberManage(page) {
  session.menuManageView = {
    familyId: session.family.id,
    category: page.data.category,
    scrollTop: page.data.scrollTop || 0,
    railTop: page.data.railTop || 0,
  };
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
  if (session.menuManageView?.familyId === session.family.id) {
    const { category, scrollTop, railTop } = session.menuManageView;
    this.setData({ category, scrollTop, railTop });
  }
  syncDraft(this);
}
function changed(page) {
  session.menuDraft.dirty = true;
  syncDraft(page);
  if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '菜单修改尚未保存' });
}
const manageMethods = {
  rememberScroll(e) {
    this.data.scrollTop = e.detail.scrollTop;
    rememberManage(this);
  },
  rememberRail(e) {
    this.data.railTop = e.detail.scrollTop;
    rememberManage(this);
  },
  editDish(e) {
    rememberManage(this);
    go('editDish', { id: e.currentTarget.dataset.id });
  },
  addDish() {
    rememberManage(this);
    go('editDish', { collectionId: this.data.category });
  },
  category(e) {
    this.setData({ category: e.currentTarget.dataset.id, scrollTop: 0 });
    rememberManage(this);
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
    if (session.menuDraft.dishes.some((d) => groups.contains(d, id)))
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
      this.setData({ category: session.menuDraft.collections[0]?.id || '' });
      rememberManage(this);
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
  moveCollection(e) {
    const id = e.currentTarget.dataset.id;
    const draft = session.menuDraft;
    if (!draft?.dishes.some((d) => d.id === id)) throw Error('请重新打开这道菜');
    this.setData({ showMove: true, movingId: id, moveTargets: draft.collections });
  },
  closeMove() {
    this.setData({ showMove: false });
  },
  selectMove(e) {
    const draft = session.menuDraft,
      target = draft.collections.find((c) => c.id === e.currentTarget.dataset.id),
      dish = draft.dishes.find((d) => d.id === this.data.movingId);
    if (!target || !dish) throw Error('合集已变化，请重试');
    // Move only the membership currently being viewed; preserve other memberships.
    const from = this.data.category;
    dish.collectionIds = [...new Set([...groups.ids(dish).filter((id) => id !== from), target.id])];
    dish.collectionId = dish.collectionIds[0];
    if (draft.recipes[dish.id])
      Object.assign(draft.recipes[dish.id], {
        collectionId: dish.collectionId,
        collectionIds: dish.collectionIds,
      });
    this.setData({ showMove: false });
    changed(this);
  },
  move(e) {
    const { id, dir, type } = e.currentTarget.dataset;
    const list = type === 'collections' ? session.menuDraft.collections : session.menuDraft.dishes;
    const i = list.findIndex((x) => x.id === id),
      visible =
        type === 'collections' ? list : list.filter((d) => groups.contains(d, this.data.category)),
      target = visible[visible.findIndex((x) => x.id === id) + Number(dir)],
      j = target ? list.findIndex((x) => x.id === target.id) : -1;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    changed(this);
  },
  async saveMenu() {
    const d = session.menuDraft;
    this.setData({ saving: true });
    try {
      const saved = await api.request(familyPath('/menu-layout'), {
        method: 'PUT',
        body: {
          version: d.version,
          collections: d.collections.map((c) => ({ id: c.id, name: c.name })),
          dishes: d.dishes.map((x) => ({
            id: x.id,
            collectionId: x.collectionId,
            collectionIds: groups.ids(x),
          })),
          deletedDishIds: d.deleted.filter((id) => !id.startsWith('draft-')),
          recipes: Object.entries(d.recipes).map(([id, body]) => ({ id, body })),
        },
      });
      if (saved.collectionMap?.[this.data.category])
        this.setData({ category: saved.collectionMap[this.data.category] });
      rememberManage(this);
    } finally {
      this.setData({ saving: false });
    }
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
  data: {
    allDishes: [],
    dishes: [],
    collections: [],
    category: '',
    search: '',
    dirty: false,
    scrollTop: 0,
    railTop: 0,
  },
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
    collectionIds: [],
    collections: [],
    coverId: null,
    cover: '',
    featured: false,
    meatType: '',
    needsMeatType: false,
    meatTypes: require('../lib/inventory-types').meatTypes,
    spiceLevel: 1,
    ingredients: [{ name: '', quantity: 1, unit: '个' }],
    steps: [{ text: '', imageId: null }],
    version: null,
  },
  async reload() {
    if (this.loaded) return;
    this.setData({ inDraft: !!session.menuDraft });
    const menu = session.menuDraft
      ? { family: session.menuDraft.family, collections: session.menuDraft.collections }
      : await api.request(familyPath('/menu'));
    if (menu.family.role !== 'cook') {
      go('forbidden');
      return;
    }
    this.setData({
      collections: menu.collections,
      collectionId: this.query.collectionId || menu.collections[0]?.id || '',
      collectionIds: [this.query.collectionId || menu.collections[0]?.id].filter(Boolean),
      collectionName: menu.collections[0]?.name || '',
      needsMeatType: ['肉类', '肉禽', '荤菜'].includes(menu.collections[0]?.name),
    });
    if (this.query.id) {
      const d =
        session.menuDraft?.recipes[this.query.id] ||
        (await api.request(familyPath('/dishes/' + this.query.id + '/recipe')));
      const moved = session.menuDraft?.dishes.find((x) => x.id === this.query.id);
      if (moved) {
        d.collectionId = moved.collectionId;
        d.collectionIds = groups.ids(moved);
      }
      this.setData({
        ...d,
        collectionName: menu.collections.find((c) => c.id === d.collectionId)?.name || '',
        collectionIds: groups.ids(d),
        needsMeatType: groups.needsMeat(menu.collections, groups.ids(d)),
        cover: d.coverId ? await api.image(d.coverId, '') : '',
        steps: await Promise.all(
          d.steps.map(async (s) => ({
            ...s,
            image: s.imageId ? await api.image(s.imageId, '') : '',
          })),
        ),
      });
    }
    this.setData({ needsMeatType: groups.needsMeat(menu.collections, this.data.collectionIds) });
    this.loaded = true;
  },
  methods: {
    meat(e) {
      this.setData({ meatType: e.currentTarget.dataset.type });
    },
    featured(e) {
      this.setData({ featured: e.detail.value });
    },
    spice(e) {
      this.setData({ spiceLevel: Number(e.currentTarget.dataset.level) });
    },
    collection(e) {
      const id = e.currentTarget.dataset.id;
      const selected = this.data.collectionIds.includes(id)
        ? this.data.collectionIds.filter((x) => x !== id)
        : [...this.data.collectionIds, id];
      this.setData({
        collectionIds: selected,
        collectionId: selected[0] || '',
        needsMeatType: groups.needsMeat(this.data.collections, selected),
      });
    },
    field(e) {
      if (e?.detail?.value === undefined) return;
      const { list, index, field } = e.currentTarget.dataset;
      if (!['ingredients', 'steps'].includes(list) || !this.data[list]?.[Number(index)] || !field)
        return;
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
      const isStep = e.currentTarget.dataset.kind === 'step';
      let file = picked.tempFiles[0].tempFilePath;
      if (isStep) {
        const choice = await new Promise((resolve, reject) =>
          wx.showActionSheet({
            itemList: ['完整使用原图', '自由裁剪 / 编辑后使用'],
            success: resolve,
            fail: reject,
          }),
        );
        if (choice.tapIndex === 1 && wx.editImage) {
          const edited = await new Promise((resolve, reject) =>
            wx.editImage({ src: file, success: resolve, fail: reject }),
          );
          file = edited.tempFilePath;
        } else if (choice.tapIndex === 1)
          wx.showToast({ title: '此版本不支持编辑，将使用完整原图', icon: 'none' });
      }
      const out = await api.upload(file, { crop: !isStep });
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
      if (d.needsMeatType && !d.meatType) throw Error('请选择菜品的肉类小分类');
      if (!d.collectionIds.length) throw Error('至少选择一个合集');
      const body = {
        name: d.name,
        intro: d.intro,
        featured: !!d.featured,
        spiceLevel: d.spiceLevel || 1,
        meatType: d.needsMeatType ? d.meatType : '',
        collectionId: d.collectionIds[0],
        collectionIds: d.collectionIds,
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
          .filter((s) => s.text?.trim() || s.imageId)
          .map((s) => ({ text: s.text || '', imageId: s.imageId || null })),
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
        go('manage', {}, { replace: true });
        return;
      }
      await api.request(familyPath('/dishes' + (this.query.id ? '/' + this.query.id : '')), {
        method: this.query.id ? 'PUT' : 'POST',
        body,
      });
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      go('manage', {}, { replace: true });
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
