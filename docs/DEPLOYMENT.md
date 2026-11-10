# 部署、数据与备份

## 本地

`npm.cmd ci --ignore-scripts` → 可选 `npm.cmd run dev:seed` → `npm.cmd run dev`。

本地数据库位于 `.runtime/postgres`，图片位于 `.runtime/media`。它们独立于小程序页面、未纳入Git；不要在运行时复制数据库目录。数据库同一时间只允许一个本机服务进程使用，种子和备份应先停服务。

## 正式服务器

使用受支持的Linux、Docker与Compose，数据库为PostgreSQL17，API为Node.js24。按 `.env.example` 配置服务端环境，额外提供 `DOMAIN`、高强度 `POSTGRES_PASSWORD`，以及独立随机的 TOKEN_PEPPER、MEDIA_SIGNING_KEY。启用手机号时需 PHONE_ENCRYPTION_KEY（64位hex）和供应商配置。不要把真实.env提交到Git。

```sh
docker compose up -d --build
```

Caddy监听80/443并管理HTTPS，数据库和API不直接发布端口。域名必须指向服务器并可申请证书；在微信小程序后台登记合法域名。首次服务启动自动执行带校验值的迁移。多个API实例共享PostgreSQL；本地PGlite不是生产多实例数据库。

生产必须为数据库用户划分迁移与运行权限，按实际服务器选择PostgreSQL证书验证。Compose是单机部署基线，不代替高可用、入侵监控或灾备方案。

## 手机号与微信

WECHAT_SECRET仅用于服务端微信code交换。微信手机号还要求后台接口资格；短信配置SMS_SECRET_ID、SMS_SECRET_KEY、SMS_APP_ID、SMS_SIGN_NAME、SMS_TEMPLATE_ID。模板变量为验证码；若模板还含分钟数，设置SMS_WITH_MINUTES=true。实际短信费用和发送量由你自己的服务账号承担；先用测试号码联调。

## 数据组织

账号、微信身份与会话；家庭与成员；合集、公开菜品、私有做法；个人/家庭库存；邀请；点餐与来源快照；换菜；菜谱分享与导入回执；解散与逐人投票；通知与审计分别建表。数量按同名同单位汇总，不将“个”和“克”直接相加。已有库存仅代表已录入，仍需核对足量。

每日保留期任务启动时及每6小时执行，清理三个自然月之前的餐次关联记录；不会删除仍在使用的菜谱和库存。

## 备份与恢复

`npm.cmd run db:backup`：本地在停API后复制数据库与图片；PostgreSQL环境使用pg_dump（需安装客户端），连接凭据从环境传入，不放在命令参数中。备份在 `.runtime/backups`，不得提交或分享。

恢复本地备份：停API，保留原目录副本，将备份postgres目录还原到DATABASE_DIR，将media还原到MEDIA_DIR；先在隔离副本启动并核对用户、家庭、图片和点餐数量，再切换。

PostgreSQL用pg_restore恢复到新的隔离数据库，核对迁移校验、表计数和关键流程，再切换DATABASE_URL。不要直接覆盖唯一生产库。密钥要独立备份，丢失PHONE_ENCRYPTION_KEY会导致手机号不可解密。
