const state = { user: null, token: '', family: null, cart: {}, pendingLink: null };
module.exports = Object.assign(state, {
  restore() {
    try {
      state.token = wx.getStorageSync('menu.session') || '';
      state.family = wx.getStorageSync('menu.family') || null;
    } catch {
      /* Storage is optional; the next login restores server state. */
    }
  },
  saveAuth(result) {
    state.token = result.token;
    state.user = result.user;
    wx.setStorageSync('menu.session', result.token);
  },
  setFamily(family) {
    state.family = family;
    state.cart = {};
    wx.setStorageSync('menu.family', family);
  },
  clear() {
    state.token = '';
    state.user = null;
    state.family = null;
    state.cart = {};
    wx.removeStorageSync('menu.session');
    wx.removeStorageSync('menu.family');
  },
});
