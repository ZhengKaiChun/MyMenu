const hosts = [];
module.exports = {
  mount(host) {
    hosts.push(host);
  },
  unmount(host) {
    const i = hosts.indexOf(host);
    if (i >= 0) hosts.splice(i, 1);
  },
  show(options) {
    const host = hosts[hosts.length - 1];
    if (!host) return wx.showModal(options);
    host.present(options);
  },
};
