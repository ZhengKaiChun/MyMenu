const { createPage } = require('../lib/page');
for (const [name, title, message, icon] of [
  ['empty', '空菜单，也有满满期待', '从第一道拿手菜开始。', 'book'],
  ['noResult', '这道菜，还没住进小家', '换个名字，或看看其他合集。', 'search'],
  ['offline', '信号去买菜了', '网络暂时断开，重新连接后再试一次。', 'wifi'],
  ['forbidden', '小家的钥匙，换了一把', '你当前没有权限执行这个操作。', 'lock'],
  ['expired', '这封邀请，暂时过期了', '请让小猪重新寄一封邀请。', 'key'],
])
  exports[name] = createPage({ data: { title, message, icon } });
