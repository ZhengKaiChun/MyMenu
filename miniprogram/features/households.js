const { createPage, go, session, api, familyPath } = require('../lib/page');
exports.home = createPage({
  data: { families: [] },
  async reload() {
    const [user, families, inventory] = await Promise.all([
      api.request('/me'),
      api.request('/families'),
      api.request('/inventory'),
    ]);
    user.avatar = user.avatarId ? await api.image(user.avatarId, '') : '';
    session.user = user;
    let family = families.find((f) => f.id === session.family?.id) || null;
    if (!family) session.family = null;
    this.setData({ user, families, family, personalCount: inventory.length });
  },
  methods: {
    enter(e) {
      const f = this.data.families.find((f) => f.id === e.currentTarget.dataset.id);
      session.setFamily({ ...f, ownerId: f.owner_id });
      go('menu');
    },
  },
});
exports.create = createPage({
  data: { name: '' },
  methods: {
    async submit() {
      if (!this.data.name.trim()) throw Error('给小家起个名字吧');
      const f = await api.request('/families', { method: 'POST', body: { name: this.data.name } });
      session.setFamily({ ...f, ownerId: session.user.id, version: 1 });
      wx.redirectTo({ url: '/pages/menu/index' });
    },
  },
});
exports.join = createPage({
  data: { token: '' },
  methods: {
    async submit() {
      if (!this.data.token.trim()) throw Error('请输入邀请码');
      go('invitation', { token: this.data.token.trim() });
    },
  },
});
exports.invitation = createPage({
  data: { invitation: null },
  async reload() {
    this.setData({
      invitation: await api.request('/invitations/' + encodeURIComponent(this.query.token)),
    });
  },
  methods: {
    async accept() {
      const out = await api.request(
          '/invitations/' + encodeURIComponent(this.query.token) + '/accept',
          { method: 'POST', body: {} },
        ),
        families = await api.request('/families');
      session.setFamily(families.find((f) => f.id === out.familyId));
      wx.redirectTo({ url: '/pages/menu/index' });
    },
  },
});
exports.family = createPage({
  data: { members: [], proposal: null },
  async reload() {
    if (!session.family) {
      go('home');
      return;
    }
    const families = await api.request('/families');
    const family = families.find((f) => f.id === session.family.id);
    if (!family) {
      session.family = null;
      go('home');
      return;
    }
    session.family = family;
    this.setData({
      family,
      members: await api.request(familyPath('/members')),
      proposal: await api.request(familyPath('/dissolution')),
      isOwner: family.owner_id === session.user?.id,
    });
  },
  methods: {
    async rename() {
      let result = await new Promise((resolve) =>
        require('../lib/dialog').show({
          title: '给小家换个名字',
          editable: true,
          placeholderText: this.data.family.name,
          success: resolve,
        }),
      );
      if (result.confirm && result.content) {
        await api.request(familyPath(''), {
          method: 'PATCH',
          body: { name: result.content, version: this.data.family.version },
        });
        await this.onShow();
      }
    },
    async transfer() {
      const members = this.data.members.filter((m) => m.user_id !== session.user.id);
      if (!members.length) throw Error('先邀请一位家庭成员');
      let out = await new Promise((resolve) =>
        wx.showActionSheet({ itemList: members.map((m) => m.nickname), success: resolve }),
      );
      await api.request(familyPath('/transfer'), {
        method: 'POST',
        body: { userId: members[out.tapIndex].user_id },
      });
      await this.onShow();
    },
    async leave() {
      let answer = await new Promise((resolve) =>
        require('../lib/dialog').show({
          title: '退出这个小家？',
          content: '个人账号和个人食材保留。',
          success: resolve,
        }),
      );
      if (answer.confirm) {
        await api.request(familyPath('/leave'), { method: 'POST', body: {} });
        session.family = null;
        wx.reLaunch({ url: '/pages/home/index' });
      }
    },
  },
});
exports.members = createPage({
  data: { members: [] },
  async reload() {
    const members = await api.request(familyPath('/members'));
    this.setData({ members, isOwner: session.family.owner_id === session.user?.id });
  },
  methods: {
    async role(e) {
      const uid = e.currentTarget.dataset.id;
      let out = await new Promise((resolve) =>
        wx.showActionSheet({
          itemList: ['大懒猪 · 吃饭的', '饲养员 · 一起做饭'],
          success: resolve,
        }),
      );
      await api.request(familyPath('/members/' + uid + '/role'), {
        method: 'POST',
        body: { role: out.tapIndex === 1 ? 'cook' : 'eater' },
      });
      await this.onShow();
    },
  },
});
exports.invite = createPage({
  data: { role: 'eater', invitation: null, showCode: false },
  async reload() {
    if (!this.data.invitation)
      this.setData({
        invitation: await api.request(familyPath('/invitations'), {
          method: 'POST',
          body: { role: this.data.role },
        }),
      });
  },
  methods: {
    async chooseRole(e) {
      this.setData({ role: e.currentTarget.dataset.role, invitation: null });
      this.setData({
        invitation: await api.request(familyPath('/invitations'), {
          method: 'POST',
          body: { role: this.data.role },
        }),
      });
    },
    async prepare() {
      const invitation = await api.request(familyPath('/invitations'), {
        method: 'POST',
        body: { role: this.data.role },
      });
      this.setData({ invitation });
    },
    async code() {
      if (!this.data.invitation)
        this.setData({
          invitation: await api.request(familyPath('/invitations'), {
            method: 'POST',
            body: { role: this.data.role },
          }),
        });
      this.setData({ showCode: true });
    },
    closeCode() {
      this.setData({ showCode: false });
    },
    copyCode() {
      wx.setClipboardData({ data: this.data.invitation.token });
    },
  },
  onShareAppMessage() {
    let invitation = this.data.invitation;
    return invitation
      ? {
          title: invitation.title,
          imageUrl: '/assets/invitation-share.png',
          path: '/pages/invitation/index?token=' + encodeURIComponent(invitation.token),
        }
      : { title: '给我饭', path: '/pages/home/index' };
  },
});
exports.identity = createPage({
  data: {
    names: ['野生小猪', '猪爸爸', '猪妈妈', '猪大二', '猪二儿', '猪大妞', '猪二妞'],
    indices: [7, 1, 2, 3, 4, 5, 6],
    selected: '野生小猪',
  },
  async reload() {
    this.setData({ selected: session.family?.identity || '野生小猪' });
  },
  methods: {
    choose(e) {
      this.setData({ selected: e.currentTarget.dataset.name });
    },
    async submit() {
      await api.request(familyPath('/identity'), {
        method: 'PATCH',
        body: { identity: this.data.selected },
      });
      session.family.identity = this.data.selected;
      session.setFamily(session.family);
      wx.redirectTo({ url: '/pages/family/index' });
    },
  },
});
exports.dissolve = createPage({
  data: { proposal: null, showConfirm: false, status: '', canVote: false },
  async reload() {
    const p = await api.request(familyPath('/dissolution'));
    this.setData({
      proposal: p,
      status: p
        ? {
            pending: '等每一位成员的确认',
            rejected: '有人不同意，小家保留',
            completed: '全员同意，小家已解散',
            cancelled: '发起人已撤回',
            invalidated: '成员变动，请重新发起',
          }[p.status]
        : '',
      canVote:
        !!p &&
        p.status === 'pending' &&
        p.votes.some((v) => v.user_id === session.user.id && !v.decision),
      isInitiator: p?.initiator === session.user.id,
    });
  },
  methods: {
    confirm() {
      this.setData({ showConfirm: true });
    },
    close() {
      this.setData({ showConfirm: false });
    },
    async start() {
      const out = await api.request(familyPath('/dissolution'), { method: 'POST', body: {} });
      this.setData({ showConfirm: false });
      if (out.status === 'completed') {
        session.family = null;
        wx.reLaunch({ url: '/pages/home/index' });
      } else await this.onShow();
    },
    async vote(e) {
      const result = await api.request(
        familyPath('/dissolution/' + this.data.proposal.id + '/vote'),
        { method: 'POST', body: { decision: e.currentTarget.dataset.decision } },
      );
      if (result.status === 'completed') {
        session.family = null;
        wx.showToast({ title: '全员同意，小家已解散', icon: 'none' });
        wx.reLaunch({ url: '/pages/home/index' });
      } else await this.onShow();
    },
    async cancel() {
      await api.request(familyPath('/dissolution/' + this.data.proposal.id + '/cancel'), {
        method: 'POST',
        body: {},
      });
      await this.onShow();
    },
  },
});
