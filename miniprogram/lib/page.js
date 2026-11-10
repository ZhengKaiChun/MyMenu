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
          if (this.query.familyId && this.query.familyId !== session.family?.id) {
            const homes = await api.request('/families');
            const home = homes.find((f) => f.id === this.query.familyId);
            if (!home) throw new Error('这个小家已解散或你已离开');
            session.setFamily(home);
            this.setData({ family: home });
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
        if (e.status === 401 && ['UNAUTHENTICATED', 'SESSION_EXPIRED'].includes(e.code)) {
          session.clear();
          wx.redirectTo({ url: '/pages/login/index' });
          return;
        }
        if (e.errMsg && e.errMsg.includes('cancel')) return;
        if (e.code === 'FAMILY_NOT_FOUND') {
          session.family = null;
          wx.reLaunch({ url: '/pages/home/index' });
          return;
        }
        const message = e.message || '操作暂未完成，请稍后重试';
        this.setData({ error: message });
        wx.showToast({
          title: e.message || '操作暂未完成，请稍后重试',
          icon: 'none',
          duration: 2800,
        });
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
