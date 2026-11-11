const { createPage, go, session, api } = require('../lib/page');
async function afterLogin(result) {
  session.saveAuth(result);
  if (session.pendingLink) {
    const link = session.pendingLink;
    session.pendingLink = null;
    const path = '/' + link.page.replace(/^\//, '');
    wx.reLaunch({
      url:
        path +
        '?' +
        Object.keys(link.query)
          .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(link.query[k]))
          .join('&'),
    });
  } else wx.reLaunch({ url: '/pages/home/index' });
}
const publicData = { consent: false, username: '', password: '', confirm: '', phone: '', code: '' };
exports.login = createPage({
  public: true,
  data: { ...publicData, capabilities: {} },
  async reload() {
    if (session.token) {
      await afterLogin({ token: session.token, user: await api.request('/me') });
      return;
    }
    this.setData({ capabilities: await api.request('/capabilities') });
  },
  methods: {
    async wechatPhone(e) {
      if (!this.data.consent) throw Error('请先同意服务协议与隐私说明');
      if (!e.detail.code) throw Error('你尚未授权手机号');
      await afterLogin(
        await api.request('/auth/wechat-phone', { method: 'POST', body: { code: e.detail.code } }),
      );
    },
    consent(e) {
      this.setData({ consent: e.detail.value.length > 0 });
    },
    async wechat() {
      if (api.isPreview()) {
        if (!this.data.consent) throw Error('请先阅读并同意服务协议与隐私说明');
        await afterLogin(
          await api.request('/auth/preview', { method: 'POST', body: { role: 'cook' } }),
        );
        return;
      }
      if (!this.data.consent) throw Error('请先阅读并同意服务协议与隐私说明');
      const out = await new Promise((resolve, reject) =>
        wx.login({ success: resolve, fail: reject }),
      );
      await afterLogin(
        await api.request('/auth/wechat', { method: 'POST', body: { code: out.code } }),
      );
    },
    legal() {
      require('../lib/dialog').show({
        title: '隐私与服务说明',
        content:
          '我们仅为账号、小家菜谱、点餐和消息使用你主动提供的信息。菜谱做法只向饲养员及你主动分享的收件人开放。可以退出登录或申请注销，正式上线前需在微信后台配置并审核隐私声明。',
        showCancel: false,
      });
    },
  },
});
exports.password = createPage({
  public: true,
  data: { ...publicData },
  methods: {
    consent(e) {
      this.setData({ consent: e.detail.value.length > 0 });
    },
    async submit() {
      if (!this.data.consent) throw Error('请先同意服务协议与隐私说明');
      await afterLogin(
        await api.request('/auth/password', {
          method: 'POST',
          body: { username: this.data.username, password: this.data.password },
        }),
      );
    },
  },
});
exports.register = createPage({
  public: true,
  data: { ...publicData },
  methods: {
    consent(e) {
      this.setData({ consent: e.detail.value.length > 0 });
    },
    async submit() {
      if (!this.data.consent) throw Error('请先同意服务协议与隐私说明');
      if (this.data.password !== this.data.confirm) throw Error('两次输入的密码不一致');
      await afterLogin(
        await api.request('/auth/register', {
          method: 'POST',
          body: { username: this.data.username, password: this.data.password },
        }),
      );
    },
  },
});
async function sendCode() {
  if (this.data.countdown) return;
  await api.request('/auth/sms/send', { method: 'POST', body: { phone: this.data.phone } });
  this.setData({ countdown: 60 });
  this.timer = setInterval(() => {
    const n = this.data.countdown - 1;
    this.setData({ countdown: n });
    if (n <= 0) clearInterval(this.timer);
  }, 1000);
}
exports.sms = createPage({
  public: true,
  data: { ...publicData, countdown: 0, binding: false },
  init(q) {
    this.binding = q.bind === '1';
    this.setData({ binding: this.binding });
  },
  dispose() {
    if (this.timer) clearInterval(this.timer);
  },
  methods: {
    consent(e) {
      this.setData({ consent: e.detail.value.length > 0 });
    },
    sendCode,
    async submit() {
      if (!this.binding && !this.data.consent) throw Error('请先同意服务协议与隐私说明');
      const body = { phone: this.data.phone, code: this.data.code };
      if (this.binding) {
        await api.request('/me/phone', { method: 'POST', body });
        wx.redirectTo({ url: '/pages/settings/index' });
      } else await afterLogin(await api.request('/auth/sms', { method: 'POST', body }));
    },
  },
});
exports.recover = createPage({
  public: true,
  data: { ...publicData, countdown: 0, capabilities: {} },
  async reload() {
    this.setData({ capabilities: await api.request('/capabilities') });
  },
  dispose() {
    if (this.timer) clearInterval(this.timer);
  },
  methods: {
    sendCode,
    async submit() {
      await api.request('/auth/recover', {
        method: 'POST',
        body: { phone: this.data.phone, code: this.data.code, password: this.data.password },
      });
      wx.showToast({ title: '已重设，请重新登录', icon: 'none' });
      wx.redirectTo({ url: '/pages/password/index' });
    },
  },
});
exports.profile = createPage({
  data: { nickname: '', avatarId: null, avatar: '' },
  async reload() {
    let u = await api.request('/me');
    this.setData({
      nickname: u.nickname,
      avatarId: u.avatarId,
      avatar: u.avatarId ? await api.image(u.avatarId, '') : '',
    });
  },
  methods: {
    async chooseAvatar(e) {
      const out = await api.upload(e.detail.avatarUrl);
      this.setData({ avatarId: out.id, avatar: await api.image(out.id, '') });
    },
    async submit() {
      await api.request('/me', {
        method: 'PATCH',
        body: { nickname: this.data.nickname, avatarId: this.data.avatarId },
      });
      session.user = await api.request('/me');
      wx.redirectTo({ url: '/pages/settings/index' });
    },
  },
});
exports.settings = createPage({
  async reload() {
    const user = await api.request('/me');
    user.avatar = user.avatarId ? await api.image(user.avatarId, '') : '';
    this.setData({ user, capabilities: await api.request('/capabilities') });
  },
  methods: {
    async previewRole(e) {
      const role = e.currentTarget.dataset.role;
      const result = await api.request('/auth/preview', { method: 'POST', body: { role } });
      session.clear();
      session.saveAuth(result);
      wx.reLaunch({ url: '/pages/home/index' });
    },
    async bindWechat() {
      const result = await new Promise((resolve, reject) =>
        wx.login({ success: resolve, fail: reject }),
      );
      await api.request('/me/wechat', { method: 'POST', body: { code: result.code } });
      wx.showToast({ title: '微信身份已绑定', icon: 'none' });
    },
    async subscribe() {
      const templateId = this.data.capabilities.subscriptionTemplateId;
      if (!templateId) throw Error('订阅提醒尚未配置，站内通知正常可用');
      const result = await new Promise((resolve, reject) =>
        wx.requestSubscribeMessage({ tmplIds: [templateId], success: resolve, fail: reject }),
      );
      await api.request('/notifications/subscribe', {
        method: 'POST',
        body: { templateId, accepted: result[templateId] === 'accept' },
      });
      wx.showToast({
        title: result[templateId] === 'accept' ? '已开启一次开饭提醒' : '仍可查看站内回音',
        icon: 'none',
      });
    },
    bindPhone() {
      go('sms', { bind: '1' });
    },
    async logout() {
      await api.request('/auth/logout', { method: 'POST', body: {} });
      session.clear();
      wx.reLaunch({ url: '/pages/login/index' });
    },
    async deleteAccount() {
      const answer = await new Promise((resolve) =>
        require('../lib/dialog').show({
          title: '注销账号',
          content:
            '注销会撤销登录会话。创建者须先转让或按全员同意流程解散小家；此操作不能直接撤销。',
          confirmText: '确认注销',
          success: resolve,
        }),
      );
      if (!answer.confirm) return;
      await api.request('/me', { method: 'DELETE', body: { confirm: true } });
      session.clear();
      wx.reLaunch({ url: '/pages/login/index' });
    },
  },
});
