function parentUrl(page) {
  const name = (page?.route || '').split('/')[1];
  const parents = {
    menu: 'home',
    editDish: 'manage',
    manage: 'family',
    collections: 'manage',
    recipe: 'menu',
    dish: 'menu',
    shopping: 'today',
    calendar: 'today',
    match: 'pantry',
    ingredientEdit: page?.query?.scope === 'personal' ? 'personal' : 'pantry',
    personal: 'home',
    settings: 'home',
    profile: 'settings',
    members: 'family',
    identity: 'family',
    invite: 'family',
    dissolve: 'family',
    requests: 'menu',
    requestDetail: 'requests',
    changes: 'today',
    swap: 'changes',
    changeDetail: 'changes',
    shareRecipes: 'family',
    recipeParcel: 'shareRecipes',
    recipeGift: 'home',
    copyRecipes: 'recipeGift',
    copyDone: 'family',
    checkout: 'menu',
    sent: 'today',
  };
  return '/pages/' + (parents[name] || 'home') + '/index';
}
Component({
  options: { multipleSlots: true, styleIsolation: 'shared' },
  properties: { title: String, back: { type: Boolean, value: true } },
  data: { top: 24, navHeight: 44 },
  lifetimes: {
    attached() {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const capsule = wx.getMenuButtonBoundingClientRect();
      this.setData({
        top: info.statusBarHeight || 24,
        navHeight: (capsule.top - (info.statusBarHeight || 24)) * 2 + capsule.height,
      });
    },
  },
  methods: {
    back() {
      if (getCurrentPages().length > 1) wx.navigateBack();
      else {
        wx.redirectTo({ url: parentUrl(getCurrentPages().slice(-1)[0]) });
      }
    },
  },
});
