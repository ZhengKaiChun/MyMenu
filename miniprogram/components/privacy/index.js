Component({
  data: { visible: false, contract: '隐私保护指引' },
  lifetimes: {
    attached() {
      this.privacyHandler = (resolve) => {
        this.resolvePrivacy = resolve;
        this.setData({ visible: true });
        if (wx.getPrivacySetting)
          wx.getPrivacySetting({
            success: (r) => this.setData({ contract: r.privacyContractName || '隐私保护指引' }),
          });
      };
    },
    detached() {
      if (wx.offNeedPrivacyAuthorization && this.privacyHandler)
        wx.offNeedPrivacyAuthorization(this.privacyHandler);
    },
  },
  pageLifetimes: {
    show() {
      if (wx.onNeedPrivacyAuthorization) wx.onNeedPrivacyAuthorization(this.privacyHandler);
    },
    hide() {
      if (wx.offNeedPrivacyAuthorization) wx.offNeedPrivacyAuthorization(this.privacyHandler);
    },
  },
  methods: {
    contract() {
      if (wx.openPrivacyContract) wx.openPrivacyContract({});
    },
    agree() {
      if (this.resolvePrivacy) this.resolvePrivacy({ event: 'agree', buttonId: 'privacy-agree' });
      this.setData({ visible: false });
    },
    decline() {
      if (this.resolvePrivacy) this.resolvePrivacy({ event: 'disagree' });
      this.setData({ visible: false });
    },
  },
});
