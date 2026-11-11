# 给我饭 · 微信原生小程序

原生WXML/WXSS/JS界面，按已确认的V12设计稿修订。47个页面，暖白配色、原版小猪、手绘物件、邀请信与备菜便签。后端按业务分模块，账号、家庭、菜谱、食材与点餐分别组织。

## 直接导入并体验

打开微信开发者工具，导入本项目根目录（包含project.config.json的menu目录），AppID已经填写。点击编译，在登录页勾选协议，点“直接体验小厨房”即可。

**默认本机体验无需启动后台、安装npm依赖或关闭合法域名校验。** 菜图随包提供，体验数据仅保存在当前设备。创建小家成为饲养员，使用另一账号加入小家成为大懒猪，体验点菜、回音、换菜、食材、复制菜谱与全员解散。也可注册一个本机测试账号，从野生小猪和空小家开始；请勿使用真实密码。

本机体验不是真实微信登录，不会发送真实短信、微信订阅消息，也不能在两台设备间同步。微信分享卡片可以展示界面，但体验邀请与菜谱数据只在发出它的设备上；跨设备接收需要配置正式后端。体验存储与正式登录状态分开，正式发布环境禁止使用体验存储。

详见[导入指南](docs/DEVTOOLS.md)。

## 真实独立后端与数据库

配置后可切换到服务端数据，原有真实业务实现保留。需要Node.js24或更新版本。在根目录运行：

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run dev:seed
npm.cmd run dev
```

另一个终端运行`node scripts/configure.mjs development http://127.0.0.1:3000`，仅此本地联网方式需要在微信工具中临时关闭合法域名校验。可选的dev:seed生成两个本机测试账号，随机密码在.runtime/demo-accounts.json，不进入Git。默认开发数据库位于.runtime/postgres，使用独立服务端的持久化PGlite PostgreSQL引擎；生产配置DATABASE_URL使用独立PostgreSQL。

正式部署HTTPS后，运行`node scripts/configure.mjs production https://你的后端域名`，再配置微信合法域名、AppSecret、隐私声明和实际使用的短信/订阅服务。密钥仅在服务端.env，不能写入小程序或Git。详见[部署与备份](docs/DEPLOYMENT.md)。

## 工程与验证

- miniprogram/pages、features、components：页面、业务控制器和通用组件。
- miniprogram/preview：独立本机体验传输与数据，正式接口不调用它。
- server/src/modules、core：独立后端、权限、校验、数据库事务与身份安全。
- server/migrations：带内容校验的数据库版本；design/baseline.json记录设计来源。
- server/test：真实数据库、原生控制器、本机体验及权限测试。

运行`npm.cmd run lint`、`npm.cmd run check`、`npm.cmd test`和`npm.cmd audit --omit=dev`。本机check使用微信官方模板/样式编译器；无微信工具的CI检查结构与语法。发布采用Git提交、版本标签、依赖锁定、源码zip、历史bundle和SHA256清单。

[数据与权限](docs/DATA.md) · [安全边界](docs/SECURITY.md) · [验证记录](docs/VERIFICATION.md)
