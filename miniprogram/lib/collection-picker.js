const groups = require('./collections');
function summary(page) {
  const names = page.data.collections
    .filter((c) => page.data.collectionIds.includes(c.id))
    .map((c) => c.name);
  page.setData({
    collectionSummary:
      names.slice(0, 2).join('、') + (names.length > 2 ? ' 等' + names.length + '个合集' : ''),
  });
}
function filter(page) {
  const query = (page.data.collectionSearch || '').trim().toLowerCase();
  page.setData({
    collectionOptions: page.data.collections.filter((c) => c.name.toLowerCase().includes(query)),
  });
}
const methods = {
  openCollections() {
    this.setData({
      showCollectionPicker: true,
      collectionSearch: '',
      draftCollectionIds: [...this.data.collectionIds],
    });
    filter(this);
  },
  closeCollections() {
    this.setData({ showCollectionPicker: false, draftCollectionIds: [], collectionSearch: '' });
  },
  searchCollections(e) {
    this.setData({ collectionSearch: e.detail.value });
    filter(this);
  },
  collection(e) {
    const id = e.currentTarget.dataset.id;
    if (!this.data.collections.some((c) => c.id === id)) return;
    const current = this.data.draftCollectionIds;
    this.setData({
      draftCollectionIds: current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    });
  },
  confirmCollections() {
    const selected = [...this.data.draftCollectionIds];
    if (!selected.length) throw Error('至少选择一个合集');
    this.setData({
      collectionIds: selected,
      collectionId: selected[0],
      needsMeatType: groups.needsMeat(this.data.collections, selected),
      showCollectionPicker: false,
    });
    summary(this);
  },
};
module.exports = { summary, methods };
