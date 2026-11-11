const { createPage } = require('../lib/page');
module.exports = createPage({
  public: true,
  data: require('../content/legal'),
  methods: {
    tab(e) {
      this.setData({ tab: e.currentTarget.dataset.id });
    },
    platform() {
      if (wx.openPrivacyContract)
        wx.openPrivacyContract({
          fail() {
            wx.showToast({ title: '平台隐私指引尚待运营者配置', icon: 'none' });
          },
        });
    },
    contact() {
      wx.setClipboardData({ data: '2834389993@qq.com' });
    },
  },
});
