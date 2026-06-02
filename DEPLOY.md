# 璇玑智脑 - Zeabur 部署指南

## 前置准备

1. 注册 [Zeabur](https://zeabur.com) 账号
2. 准备 MySQL 数据库（可在 Zeabur 上创建或自行准备）
3. 确保 GitHub 仓库已上传代码（不含 `.env`）

## 部署步骤

### 第一步：创建 GitHub 仓库

将代码推送到 GitHub（**不要包含 `.env` 文件**）：

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/xuanji-brain.git
git push -u origin main
```

### 第二步：在 Zeabur 上部署

1. 登录 [Zeabur Dashboard](https://dash.zeabur.com)
2. 点击 **Create Project**
3. 选择 **Deploy from GitHub**
4. 选择你的仓库，Zeabur 会自动识别 `Dockerfile`
5. 等待构建完成

### 第三步：配置环境变量

在 Zeabur 项目 → 你的服务 → **Variables** 中添加以下环境变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `DATABASE_URL` | MySQL 连接字符串 | `mysql://user:pass@host:3306/dbname` |
| `APP_ID` | Kimi 应用 ID | `19e86xxx-xxx-xxx` |
| `APP_SECRET` | Kimi 应用密钥 | `Vp8Hxxx...` |
| `KIMI_AUTH_URL` | Kimi 认证地址 | `https://auth.kimi.com` |
| `KIMI_OPEN_URL` | Kimi Open API | `https://open.kimi.com` |
| `VITE_APP_ID` | 前端 Kimi 应用 ID（同 APP_ID） | `19e86xxx-xxx-xxx` |
| `VITE_KIMI_AUTH_URL` | 前端认证地址 | `https://auth.kimi.com` |
| `OWNER_UNION_ID` | 管理员 Union ID | `d4im8se6s4t8dkpp6670` |

### 第四步：初始化数据库

部署完成后，需要同步数据库 Schema：

1. 在 Zeabur 中找到你的服务
2. 点击 **Console** 或 **Terminal**
3. 运行数据库推送命令：

```bash
npx drizzle-kit push
```

或者如果你有 Drizzle Studio 访问权限，也可以通过 Studio 管理。

### 第五步：绑定域名（可选）

1. 在 Zeabur 服务 → **Domains** 中
2. 点击 **Generate Domain** 获取 `.zeabur.app` 域名
3. 或绑定自定义域名

## 验证部署

部署完成后，访问以下地址验证：

| 端点 | 说明 |
|------|------|
| `https://your-app.zeabur.app` | 前端页面 |
| `https://your-app.zeabur.app/api/trpc/ping` | API 健康检查 |
| `https://your-app.zeabur.app/api/oauth/callback` | OAuth 回调地址 |

## 更新部署

每次推送代码到 GitHub 主分支，Zeabur 会自动重新构建和部署。

```bash
git add .
git commit -m "Update features"
git push
```

## 常见问题

### 数据库连接失败
- 检查 `DATABASE_URL` 是否正确
- 确保 MySQL 允许远程连接
- 检查防火墙设置

### OAuth 登录失败
- 确认 `APP_ID` 和 `APP_SECRET` 正确
- 在 Kimi 开放平台配置回调地址为 `https://your-app.zeabur.app/api/oauth/callback`

### 构建失败
- 检查 Dockerfile 是否存在
- 查看 Zeabur 构建日志排查错误
