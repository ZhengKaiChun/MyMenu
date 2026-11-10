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
      else wx.reLaunch({ url: '/pages/home/index' });
    },
  },
});
