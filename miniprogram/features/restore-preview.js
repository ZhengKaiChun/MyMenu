const { createPage, api, go } = require('../lib/page');
const dates = require('../lib/dates');
const config = require('../config/index');

function oldDatabase() {
  const raw = wx.getStorageSync(config.previewDatabaseKey || 'geiwofan.preview.database.v1');
  // The preview reader upgrades older local shapes in memory; it never saves here.
  return raw && raw.schema === 1 && Array.isArray(raw.families)
    ? require('../preview/store').read()
    : null;
}
function oldHistory(db, familyId) {
  const { min } = dates.bounds();
  const max = dates.shift(dates.today(), 90);
  return (db.orders || []).filter(
    (o) =>
      o.family_id === familyId &&
      o.status === 'accepted' &&
      o.meal_date >= min &&
      o.meal_date <= max,
  );
}
function identity(db, familyId, userId) {
  const member = (db.members || []).find((m) => m.family_id === familyId && m.user_id === userId);
  const user = (db.users || []).find((u) => u.id === userId);
  return (member?.identity || user?.nickname || '野生小猪').slice(0, 24);
}
function mediaPath(db, oldId) {
  if (/^preview-food-[0-3]$/.test(oldId)) return '/assets/food-' + oldId.slice(-1) + '.jpg';
  return db.media && db.media[oldId];
}
function personalOwner(db) {
  const token = wx.getStorageSync((config.previewSessionNamespace || 'menu.preview') + '.session');
  return db.sessions?.[token] || db.families.find((f) => f.id !== 'preview-home')?.owner_id || null;
}
function inventoryItem(i) {
  return {
    name: i.name,
    quantity: Number(i.quantity) || 0,
    unit: i.unit,
    category: ['蔬菜', '肉类', '蛋奶', '主食', '调味'].includes(i.category) ? i.category : '其他',
    meatType: i.category === '肉类' ? i.meatType || '其他' : '',
  };
}
async function buildFamily(db, f, uploadMedia) {
  const collections = (db.collections || [])
    .filter((c) => c.family_id === f.id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (!collections.length) collections.push({ id: 'old-default', name: '拿手好菜' });
  const collectionIds = new Set(collections.map((c) => c.id));
  const dishes = [];
  for (const d of (db.dishes || []).filter((d) => d.family_id === f.id && !d.archived)) {
    const groups = [
      ...new Set(
        (d.collectionIds?.length ? d.collectionIds : [d.collectionId]).filter((cid) =>
          collectionIds.has(cid),
        ),
      ),
    ];
    if (!groups.length) groups.push(collections[0].id);
    const steps = [];
    for (const step of d.steps || []) {
      const imageId = step.imageId ? await uploadMedia(step.imageId) : null;
      if ((step.text || '').trim() || imageId) steps.push({ text: step.text || '', imageId });
    }
    dishes.push({
      sourceId: String(d.id),
      name: d.name,
      intro: d.intro || '',
      collectionIds: groups,
      coverId: await uploadMedia(d.coverId),
      minutes: d.minutes || 15,
      servings: d.servings || 2,
      featured: !!d.featured,
      spiceLevel: d.spiceLevel || 1,
      meatType: d.meatType || '',
      ingredients: (d.ingredients || [])
        .filter((i) => Number(i.quantity) > 0)
        .map((i) => ({ name: i.name, quantity: Number(i.quantity), unit: i.unit })),
      steps,
    });
  }
  const grouped = new Map();
  for (const order of oldHistory(db, f.id))
    for (const line of order.items || []) {
      const snap = line.snapshot || {};
      const key = [order.meal_date, order.slot, line.dish_id].join(':');
      if (!grouped.has(key))
        grouped.set(key, {
          date: order.meal_date,
          slot: order.slot,
          name: snap.name || '旧菜品',
          oldCoverId: snap.coverId || null,
          quantity: 0,
          sources: [],
          cookerLabel: null,
        });
      const row = grouped.get(key),
        quantity = Math.max(1, Number(line.quantity) || 1);
      row.quantity += quantity;
      const label = identity(db, f.id, order.user_id);
      const source = row.sources.find((s) => s.identity === label);
      if (source) source.quantity += quantity;
      else row.sources.push({ identity: label, quantity });
      const claim = (db.cookingRecords || []).find(
        (c) =>
          c.familyId === f.id &&
          c.date === order.meal_date &&
          c.slot === order.slot &&
          c.dishId === line.dish_id,
      );
      if (claim) row.cookerLabel = identity(db, f.id, claim.userId);
    }
  const history = [];
  for (const row of grouped.values()) {
    const { oldCoverId, ...fields } = row;
    history.push({ ...fields, coverId: await uploadMedia(oldCoverId) });
  }
  const inventory = (db.inventories || []).filter((i) => i.family_id === f.id).map(inventoryItem);
  return {
    sourceId: String(f.id),
    name: f.name,
    collections: collections.map((c) => ({ sourceId: String(c.id), name: c.name })),
    dishes,
    inventory,
    history,
  };
}

module.exports = createPage({
  data: {
    families: [],
    account: '',
    selectedCount: 0,
    progress: '',
    personalCount: 0,
    personalSelected: false,
    personalImported: false,
    oldUserId: '',
  },
  async reload() {
    if (api.isPreview()) throw Error('请在正式版中找回旧预览数据');
    const db = oldDatabase();
    const [security, imported] = await Promise.all([
      api.request('/me/security'),
      api.request('/me/legacy-imports'),
    ]);
    const done = new Set((imported.imports || []).map((x) => x.source_id));
    const oldUserId = db ? personalOwner(db) : null;
    const personalCount = oldUserId
      ? (db.inventories || []).filter((i) => i.user_id === oldUserId).length
      : 0;
    const families = db
      ? db.families
          .filter((f) => f.id !== 'preview-home' && !f.deleted_at)
          .map((f) => ({
            sourceId: f.id,
            name: f.name,
            dishes: (db.dishes || []).filter((d) => d.family_id === f.id && !d.archived).length,
            ingredients: (db.inventories || []).filter((i) => i.family_id === f.id).length,
            history: oldHistory(db, f.id).reduce((n, o) => n + (o.items || []).length, 0),
            imported: done.has(f.id),
            selected: false,
          }))
      : [];
    this.setData({
      account: security.username || '微信账号（请先在账号与密码中设置登录账号）',
      families,
      selectedCount: 0,
      progress: '',
      oldUserId: oldUserId || '',
      personalCount,
      personalSelected: false,
      personalImported: oldUserId ? done.has('personal:' + oldUserId) : false,
    });
  },
  methods: {
    toggle(e) {
      const id = e.currentTarget.dataset.id;
      const families = this.data.families.map((f) =>
        f.sourceId === id && !f.imported ? { ...f, selected: !f.selected } : f,
      );
      this.setData({
        families,
        selectedCount:
          families.filter((f) => f.selected).length + (this.data.personalSelected ? 1 : 0),
      });
    },
    togglePersonal() {
      if (!this.data.personalCount || this.data.personalImported) return;
      const personalSelected = !this.data.personalSelected;
      this.setData({
        personalSelected,
        selectedCount:
          this.data.families.filter((f) => f.selected).length + (personalSelected ? 1 : 0),
      });
    },
    async restore() {
      const selected = this.data.families.filter((f) => f.selected && !f.imported);
      const withPersonal = this.data.personalSelected && !this.data.personalImported;
      if (!selected.length && !withPersonal) return;
      const answer = await new Promise((resolve) =>
        wx.showModal({
          title: '核对找回位置',
          content:
            '即将把 ' +
            selected.length +
            ' 个旧小家' +
            (withPersonal ? '和个人食材' : '') +
            '复制到正式账号「' +
            this.data.account +
            '」。旧成员需要重新邀请；旧饭历只读，现有小家不会被覆盖。',
          confirmText: '确认找回',
          success: resolve,
        }),
      );
      if (!answer.confirm) return;
      const db = oldDatabase();
      if (!db) throw Error('找不到这台手机上的旧预览数据');
      const uploaded = new Map();
      const uploadMedia = async (oldId) => {
        if (!oldId) return null;
        if (uploaded.has(oldId)) return uploaded.get(oldId);
        const path = mediaPath(db, oldId);
        if (!path) throw Error('旧图片已不在手机上：' + oldId + '。旧数据未被改动');
        this.setData({ progress: '正在带回菜品图片…' });
        const out = await api.upload(path, { crop: false });
        uploaded.set(oldId, out.id);
        return out.id;
      };
      for (const item of selected) {
        const family = db.families.find((f) => f.id === item.sourceId);
        if (!family) continue;
        this.setData({ progress: '正在准备「' + family.name + '」的菜谱…' });
        const body = await buildFamily(db, family, uploadMedia);
        this.setData({ progress: '正在保存「' + family.name + '」…' });
        await api.request('/me/legacy-imports', { method: 'POST', body });
      }
      if (withPersonal) {
        const inventory = (db.inventories || [])
          .filter((i) => i.user_id === this.data.oldUserId)
          .map(inventoryItem);
        this.setData({ progress: '正在保存旧个人食材…' });
        await api.request('/me/legacy-personal', {
          method: 'POST',
          body: { sourceUserId: this.data.oldUserId, inventory },
        });
      }
      wx.showToast({ title: '旧数据已找回', icon: 'none' });
      go('home');
    },
  },
});
