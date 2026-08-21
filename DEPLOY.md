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

| 变量 | 必填 | 说明 |
|------|------|------|
| `ADMIN_USERNAME` | 是 | 管理员登录账号 |
| `ADMIN_PASSWORD` | 是 | 管理员登录密码，请使用强密码；未设置将拒绝启动 |
| `DATABASE_URL` | 是 | MySQL 连接字符串 |
| `JWT_SECRET` | 生产必填 | JWT 签名密钥（≥32 字符随机字符串）；生产环境缺失或过短将拒绝启动 |
| `BACKUP_ENCRYPTION_KEY` | 否 | AList 加密备份的 AES-256-GCM 密钥；使用加密备份功能时必填 |

### 第三步：配置持久化存储（可选但推荐）

如需上传文件、备份、向量数据在重新部署后保留，为以下路径添加持久化存储：

- `/data/app/uploads`
- `/data/app/backups`
- `/data/app/zvec`

### 第四步：初始化数据库

部署完成后，进入 Console/Terminal：

```bash
npx drizzle-kit push
```

### 第五步：登录使用

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
首次成功登录后，密码哈希会持久化到数据库 `system_settings` 表（`admin_password_hash`），此后修改 `ADMIN_PASSWORD` 环境变量**不会生效**。重置步骤：

1. 在 MySQL 中执行：

   ```sql
   DELETE FROM system_settings WHERE `key` IN ('admin_password_hash', 'admin_password_changed_at');
   ```

2. 在 Zeabur Variables 中设置新的 `ADMIN_PASSWORD`，重新部署。
3. 使用新密码登录；首次登录成功后，新密码哈希会再次持久化。

### 更新部署

推送代码到 GitHub 主分支，Zeabur 自动重新构建：

```bash
git add .
git commit -m "更新描述"
git push
```
