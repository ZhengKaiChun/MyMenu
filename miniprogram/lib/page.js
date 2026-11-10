const session = require('./session');
const api = require('./api');
function go(page, query = {}) {
  const qs = Object.keys(query)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
    .join('&');
  wx.navigateTo({ url: '/pages/' + page + '/index' + (qs ? '?' + qs : '') });
}
function createPage(options) {
  const output = {
    data: { loading: false, error: '', ...options.data },
    onLoad(query) {
      this.query = query || {};
      if (options.public !== true && !session.token) {
        session.pendingLink = {
          page: getCurrentPages()[getCurrentPages().length - 1].route,
          query: this.query,
        };
        wx.redirectTo({ url: '/pages/login/index' });
        return;
      }
      if (options.init) options.init.call(this, query || {});
    },
    onShow() {
      if (options.public === true || session.token) {
        this.setData({ family: session.family, user: session.user });
        return this.run(async function () {
          if (session.token && !session.user) {
            session.user = await api.request('/me');
            this.setData({ user: session.user });
          }
          if (options.reload) await options.reload.call(this);
        });
      }
    },
    onUnload() {
      if (options.dispose) options.dispose.call(this);
    },
    noop() {},
    go(e) {
      const d = e.currentTarget.dataset;
      go(d.page, d.id ? { id: d.id } : {});
    },
    input(e) {
      this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
    },
    async run(fn, ...args) {
      try {
        this.setData({ loading: true, error: '' });
        return await fn.apply(this, args);
      } catch (e) {
        if (e.status === 401) {
          session.clear();
          wx.redirectTo({ url: '/pages/login/index' });
          return;
        }
        this.setData({ error: e.message });
        wx.showToast({ title: e.message, icon: 'none', duration: 2800 });
      } finally {
        this.setData({ loading: false });
      }
    },
    retry() {
      return this.run(async function () {
        if (session.token && !session.user) {
          session.user = await api.request('/me');
          this.setData({ user: session.user });
        }
        if (options.reload) await options.reload.call(this);
      });
    },
  };
  for (const [name, fn] of Object.entries(options.methods || {}))
    output[name] = function (...args) {
      if (this.data.actionBusy) return;
      this.setData({ actionBusy: true });
      return this.run(fn, ...args).finally(() => this.setData({ actionBusy: false }));
    };
  if (options.onShareAppMessage) output.onShareAppMessage = options.onShareAppMessage;
  return output;
}
async function decorate(items, token) {
  return Promise.all(
    items.map(async (d) => ({
      ...d,
      cover: await api.image(d.coverId || d.cover_id, '/assets/food-placeholder.png', token),
    })),
  );
}
function familyPath(path) {
  if (!session.family) throw new Error('请先创建或加入小家');
  return '/families/' + session.family.id + path;
}
module.exports = { createPage, go, decorate, familyPath, session, api };
