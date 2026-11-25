Component({
  properties: {
    visible: { type: Boolean, value: false },
    dishName: { type: String, value: '' },
    groups: { type: Array, value: [] },
    title: { type: String, value: '这道菜，想怎么吃？' },
    confirmText: { type: String, value: '选好了，放进菜篮' },
    hint: { type: String, value: '每组至少选一项 · 选好后加入菜篮' },
  },
  methods: {
    noop() {},
    close() {
      this.triggerEvent('close');
    },
    choose(e) {
      this.triggerEvent('choose', {
        groupId: e.currentTarget.dataset.group,
        choiceId: e.currentTarget.dataset.choice,
      });
    },
    confirm() {
      this.triggerEvent('confirm');
    },
  },
});
