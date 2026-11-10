const session = require('./lib/session');
App({
  onLaunch() {
    session.restore();
  },
  onShow(options) {
    if (!session.token && options.query && options.query.token) {
      session.pendingLink = { page: options.path, query: options.query };
    }
  },
});
