const api = require('./api');
function assertRemoteLink(query) {
  if (query?.origin === 'local-preview' && !api.isPreview())
    throw Error('这是本机体验生成的链接，不能在正式服务中使用。请让发送者连接共享后台后重新发送。');
}
function suffix() {
  return api.isPreview() ? '&origin=local-preview' : '';
}
function explain() {
  require('./dialog').show({
    title: '尚未接通跨设备分享',
    content:
      '当前是本机预览，小家和菜谱只保存在这台设备。微信好友无法读取这些数据；接通共享后台后，需要重新生成邀请或分享链接。',
    showCancel: false,
    confirmText: '我知道了',
  });
}
module.exports = { assertRemoteLink, suffix, explain };
