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
      if (!this.data.capabilities.wechat) throw Error('微信登录服务尚未配置，请先使用账号密码登录');
      const out = await new Promise((resolve, reject) =>
        wx.login({ success: resolve, fail: reject }),
      );
      await afterLogin(
        await api.request('/auth/wechat', { method: 'POST', body: { code: out.code } }),
      );
    },
    legal() {
      go('privacy');
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
  if (!this.data.capabilities?.sms)
    throw Error(
      api.isPreview()
        ? '本机预览不发送短信，可先使用账号密码注册登录'
        : '短信服务尚未配置，可先使用微信或账号密码登录',
    );
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
  data: { ...publicData, countdown: 0, binding: false, capabilities: {} },
  async reload() {
    this.setData({ capabilities: await api.request('/capabilities') });
  },
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
        go('settings', {}, { replace: true });
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
      go('password', {}, { replace: true });
    },
  },
});
exports.profile = createPage({
  data: {
    nickname: '',
    avatarId: null,
    avatar: '',
    preset: -1,
    chosenPreset: -1,
    pigOptions: Array.from({ length: 8 }, (_, i) => i),
  },
  async reload() {
    if (this.loaded) return;
    const u = await api.request('/me');
    const avatar = u.avatarId ? await api.image(u.avatarId, '') : '';
    const builtin = avatar.match(/^\/assets\/avatars\/pig-([0-7])\.png$/);
    this.setData({
      nickname: u.nickname,
      avatarId: u.avatarId,
      avatar,
      chosenPreset: builtin ? Number(builtin[1]) : -1,
    });
    this.loaded = true;
  },
  methods: {
    preset(e) {
      const preset = Number(e.currentTarget.dataset.index);
      if (!Number.isInteger(preset) || preset < 0 || preset > 7) return;
      this.setData({
        preset,
        chosenPreset: preset,
        avatar: '/assets/avatars/pig-' + preset + '.png',
      });
    },
    async customAvatar() {
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
      this.setData({
        preset: -1,
        chosenPreset: -1,
        avatarId: out.id,
        avatar: await api.image(out.id, ''),
      });
    },
    async submit() {
      if (this.data.preset >= 0) {
        const out = await api.upload(this.data.avatar, { crop: false });
        this.setData({ avatarId: out.id, preset: -1 });
      }
      await api.request('/me', {
        method: 'PATCH',
        body: { nickname: this.data.nickname, avatarId: this.data.avatarId },
      });
      session.user = await api.request('/me');
      go('settings', {}, { replace: true });
    },
  },
});
exports.settings = createPage({
  data: { notificationsEnabled: true },
  async reload() {
    const user = await api.request('/me');
    user.avatar = user.avatarId ? await api.image(user.avatarId, '') : '';
    const preferences = await api.request('/notifications/preferences');
    this.setData({
      user,
      notificationsEnabled: preferences.enabled,
      capabilities: await api.request('/capabilities'),
    });
  },
  methods: {
    async toggleNotifications(e) {
      const before = this.data.notificationsEnabled;
      this.setData({ notificationsEnabled: e.detail.value });
      try {
        await api.request('/notifications/preferences', {
          method: 'PATCH',
          body: { enabled: e.detail.value },
        });
      } catch (error) {
        this.setData({ notificationsEnabled: before });
        throw error;
      }
    },
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
