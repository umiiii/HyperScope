# HyperScope Push Lab

一个可直接部署的 Next.js PWA MVP，用来验证：安装到主屏幕、iOS Web Push、Service Worker、VAPID 服务端签名，以及 Railway 后端发送通知。

## MVP 包含什么

- Next.js 16 App Router 页面与 PWA Manifest
- `/sw.js` Service Worker，处理 `push` 与 `notificationclick`
- iOS/iPadOS 16.4+ 安装提示与推送订阅
- 运行时读取 VAPID 公钥，私钥不会进入浏览器 bundle
- `/api/push/send` 服务端即时发送测试通知
- 可选口令、输入校验与单实例限流
- Docker 多阶段构建、Railway 健康检查
- GitHub Actions：PR 校验，`main` 分支校验通过后部署

这个版本故意不使用数据库。浏览器会把当前设备的 `PushSubscription` 随测试请求交给后端，后端立即发送，所以容器重启不会影响单设备测试。需要保存订阅并群发时，再接入 Postgres。

## 本地启动

要求 Node.js 22+。

```bash
npm install
npm run vapid:generate
```

复制 `.env.example` 为 `.env.local`，将生成的公钥和私钥分别填入：

```dotenv
VAPID_SUBJECT=mailto:you@example.com
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
PUSH_ADMIN_TOKEN=
```

然后启动：

```bash
npm run dev:https
```

桌面浏览器接受本地开发证书后即可测试。iPhone 不能通过普通局域网 HTTP 测试，最省事的方式是先部署到 Railway，再使用 Railway 的 HTTPS 域名。

> VAPID 密钥只生成一次并长期保存。更换密钥会让已有设备订阅失效，需要重新订阅。`VAPID_SUBJECT` 建议使用真实 `mailto:` 地址，Safari 不接受 `https://localhost` 作为 VAPID subject。

## Railway 配置

1. 在 Railway 创建 Project 与一个空 Service，不要同时开启该 Service 的 GitHub Autodeploy。
2. 在 Service Variables 添加：

   ```text
   VAPID_SUBJECT=mailto:you@example.com
   VAPID_PUBLIC_KEY=<生成的公钥>
   VAPID_PRIVATE_KEY=<生成的私钥>
   PUSH_ADMIN_TOKEN=<至少 32 字符的随机口令>
   ```

3. 在 Railway 的 production 环境创建 Project Token。
4. 在 GitHub 仓库建立名为 `production` 的 Environment，并配置：

   | 类型 | 名称 | 值 |
   | --- | --- | --- |
   | Environment secret | `RAILWAY_TOKEN` | Railway production Project Token |
   | Environment variable | `RAILWAY_PROJECT_ID` | Railway Project ID |
   | Environment variable | `RAILWAY_ENVIRONMENT_ID` | production Environment ID |
   | Environment variable | `RAILWAY_SERVICE_ID` | 目标 Service ID |

5. 推送到 `main`。GitHub Actions 会先执行 lint、类型检查和生产构建，再上传至 Railway，并等待部署及 `/api/health` 健康检查完成。
6. 首次部署成功后，在 Railway 的 Networking 中生成公开域名。

`railway.json` 已指定 Dockerfile 和健康检查；Dockerfile 会将 `public` 与 `.next/static` 一并放入 standalone 镜像，因此 Service Worker 和安装资源不会丢失。

## iPhone 实机测试

1. 使用 Safari 打开 Railway 的 HTTPS 地址。
2. 点“分享” → “添加到主屏幕”，并保持“作为 Web App 打开”开启。
3. 从主屏幕图标打开 HyperScope。
4. 点“允许通知”并接受系统权限。
5. 输入 Railway 中的 `PUSH_ADMIN_TOKEN` 与消息，点“发送测试通知”。
6. 切到主屏幕；页面关闭后仍应收到系统通知。

如果曾拒绝权限，需要到 iOS“设置 → 通知 → HyperScope”中重新允许。推送服务返回成功只表示消息已被接收；专注模式、通知摘要、网络或系统设置仍可能延迟展示。

## 接口

- `GET /api/health`：Railway 部署健康检查
- `GET /api/push/config`：返回运行时 VAPID 公钥与是否需要测试口令
- `POST /api/push/send`：验证当前订阅并由 Node.js 后端发送通知

生产环境强制要求 `PUSH_ADMIN_TOKEN`。测试接口每个实例对同一来源和订阅每分钟最多发送 5 次。下一阶段若要支持真实用户，应增加登录、持久化订阅、失效订阅清理、共享限流与后台发送任务。
