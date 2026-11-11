const config = require('../config/index');
const prefix =
  config.mode === 'preview' ? config.previewSessionNamespace || 'menu.preview' : 'menu';
const state = { user: null, token: '', family: null, cart: {}, pendingLink: null };
module.exports = Object.assign(state, {
  restore() {
    try {
      state.token = wx.getStorageSync(prefix + '.session') || '';
      state.family = wx.getStorageSync(prefix + '.family') || null;
    } catch {
      /* Storage is optional; the next login restores server state. */
    }
  },
  saveAuth(result) {
    state.token = result.token;
    state.user = result.user;
    wx.setStorageSync(prefix + '.session', result.token);
  },
  setFamily(family) {
    state.family = family;
    state.cart = {};
    wx.setStorageSync(prefix + '.family', family);
  },
  clear() {
    require('./navigation').reset();
    state.token = '';
    state.user = null;
    state.family = null;
    state.cart = {};
    state.menuDraft = null;
    state.menuManageView = null;
    wx.removeStorageSync(prefix + '.session');
    wx.removeStorageSync(prefix + '.family');
  },
});
