# 给我饭 · 微信原生小程序

原生 WXML/WXSS/JS 页面 + 独立 Node.js 服务端 + PostgreSQL 数据库。以设计 V12 为视觉基准，保留暖白配色、原版小猪、手写菜谱信、备菜便签和双角色功能。不是网页套壳，业务数据不保存在页面本机假数据中。

## 本地开始

本机依赖和测试资料已准备好，可以双击 `start-local.cmd` 启动后端，窗口保持打开。首次在其他电脑使用时，需要 Node.js 24 或更新版本，并在项目目录打开终端：

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run dev:seed
npm.cmd run dev
```

`dev:seed` 可选，仅本地开发可执行，创建带真实菜图的两个测试账户；随机密码保存在 `.runtime/demo-accounts.json`，不会提交到 Git。若不需要演示资料，可以直接启动后自己注册。

打开微信开发者工具，导入**项目根目录**（包含 project.config.json），AppID 已设为 `wx3ab03337b159fadd`。本地联调时在开发者工具“详情 → 本地设置”临时勾选“不校验合法域名、web-view、TLS版本及HTTPS证书”。前端默认连接 `http://127.0.0.1:3000`。不要在正式环境关闭域名或证书校验。

账号登录可直接本地使用；微信登录、微信手机号、短信服务需要在服务端 `.env` 填入相应密钥和服务配置才会显示可用入口，未配置时不会伪造成功。不要把密钥发到聊天或写进小程序端。

详细导入步骤见 [微信开发者工具导入指南](docs/DEVTOOLS.md)，部署见 [部署与备份](docs/DEPLOYMENT.md)，数据分类见 [数据与权限](docs/DATA.md)，本次检查见 [验证记录](docs/VERIFICATION.md)。

## 工程划分

- `miniprogram/pages/`：47个原生页面，各有 WXML/WXSS/JS/JSON。
- `miniprogram/features/`：账号、家庭、菜谱、点餐、食材、分享的页面控制逻辑。
- `miniprogram/components/`：导航、物件图标、小猪、隐私授权等可复用组件。
- `server/src/modules/`：按业务域拆分的API，校验和权限由服务端实施。
- `server/src/core/`：身份会话、数据库事务、输入校验、幂等、错误处理。
- `server/migrations/`：带内容校验的版本化SQL迁移，不修改已执行的迁移。
- `server/test/`：真实数据库和原生控制器集成测试。
- `design/baseline.json`：设计V12的源文件校验值及本机参考位置。

本地数据库是持久化在独立服务端的 PGlite PostgreSQL 引擎，文件位于 `.runtime/postgres`；正式部署使用 `DATABASE_URL` 连接独立 PostgreSQL。两者使用相同SQL迁移，数据库不嵌在微信客户端里。

## 检查与版本

```powershell
npm.cmd run lint
npm.cmd run check
npm.cmd test
npm.cmd audit --omit=dev
npm.cmd run release
```

本机 `check` 调用已安装的微信官方 WXML/WXSS 编译器。没有微信工具的CI主机执行结构、JS语法和包体检查。版本由 Git 提交、标签、变更日志、依赖锁文件及发布SHA256清单共同追踪。`release` 要求工作区已提交、同版本的Git标签指向当前提交，生成源码zip、完整Git历史bundle及文件SHA256清单。

## 上线边界

当前版本可本地联调；真实微信登录/短信、正式HTTPS域名、隐私声明、订阅消息模板、生产数据库与备份，需要运营者配置。上传脚本会拒绝开发地址；微信工具的上传不等于审核通过或公开发布。

已经实施权限隔离、参数化SQL、输入校验、会话哈希、scrypt密码哈希、手机号加密、限流、上传重编码、事务与并发版本校验。不能承诺绝对不受攻击；正式上线还需真机与视觉验收、基础设施配置核验和安全评估，见 [安全说明](docs/SECURITY.md)。
