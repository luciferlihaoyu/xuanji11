# 璇玑智脑 - Zeabur 部署指南

## 快速部署

### 第一步：在 Zeabur 上创建项目

1. 登录 [Zeabur Dashboard](https://dash.zeabur.com)
2. 点击 **Create Project**
3. 选择 **Deploy from GitHub**
4. 选择仓库 `luciferlihaoyu/xuanji11`
5. Zeabur 会自动识别 `Dockerfile` 并构建

### 第二步：配置环境变量

在 Zeabur 项目 → 你的服务 → **Variables** 中添加：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ADMIN_USERNAME` | 是 | `admin` | 管理员登录账号 |
| `ADMIN_PASSWORD` | 是 | `xuanji123456` | 管理员登录密码 |
| `DATABASE_URL` | 是 | - | MySQL 连接字符串 |
| `JWT_SECRET` | 否 | 自动生成 | JWT 签名密钥（建议设置随机字符串）|

### 第三步：初始化数据库

部署完成后，进入 Console/Terminal：

```bash
npx drizzle-kit push
```

### 第四步：登录使用

访问部署后的域名，使用配置的管理员账号密码登录。

---

## 可选：启用 Kimi OAuth

如需支持 Kimi 账号登录（不配置则仅使用管理员账号）：

| 变量 | 说明 |
|------|------|
| `APP_ID` | Kimi 应用 ID |
| `APP_SECRET` | Kimi 应用密钥 |
| `VITE_APP_ID` | 同 APP_ID |
| `VITE_KIMI_AUTH_URL` | `https://auth.kimi.com` |
| `OWNER_UNION_ID` | 管理员 Union ID |

在 Kimi 开放平台配置回调地址为 `https://your-app.zeabur.app/api/oauth/callback`

---

## 常见问题

### 数据库连接失败
- 检查 `DATABASE_URL` 是否正确
- 确保 MySQL 允许远程连接

### 忘记密码
- 在 Zeabur Variables 中修改 `ADMIN_PASSWORD`
- 重新部署即可生效

### 更新部署

推送代码到 GitHub 主分支，Zeabur 自动重新构建：

```bash
git add .
git commit -m "更新描述"
git push
```
