const navigation = require('../../lib/navigation');
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
      navigation.back();
    },
    touchStart(e) {
      if (e.touches?.length !== 1) {
        this.gesture = null;
        return;
      }
      const t = e.touches[0];
      this.gesture = { x: t.clientX, y: t.clientY, time: Date.now() };
    },
    touchEnd(e) {
      const t = e.changedTouches?.[0];
      if (!t || !this.gesture) return;
      const end = { x: t.clientX, y: t.clientY, time: Date.now() };
      const width = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).windowWidth;
      if (navigation.isBackSwipe(this.gesture, end, width)) navigation.exitSection();
      this.gesture = null;
    },
  },
});
