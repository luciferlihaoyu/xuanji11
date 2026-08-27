# 璇玑智脑 - Zeabur 部署指南

> **Round 3+ 更新**：数据库已整合为单文件 SQLite + sqlite-vec 向量扩展，部署不再需要独立 MySQL / Zvec 服务。所有数据存于容器持久卷 `/data/app/`，升级/迁移只需替换镜像 + 挂载同一卷。

## 快速部署

### 第一步：在 Zeabur 上创建项目

1. 登录 [Zeabur Dashboard](https://dash.zeabur.com)
2. 点击 **Create Project**
3. 选择 **Deploy from GitHub**
4. 选择仓库 `luciferlihaoyu/xuanji11`
5. Zeabur 会自动识别 `Dockerfile` 并构建

### 第二步：挂载持久卷（重要）

在 Zeabur 服务 → **Storage** 中挂载卷：

| 挂载点 | 大小 | 用途 |
|------|------|------|
| `/data/app` | ≥ 5 GB | SQLite 数据库 + 上传文件 + 备份临时 + JWT 密钥 |

所有运行时数据（数据库 / 上传 / 备份 / JWT 密钥）都写在这里。**不挂载卷会导致每次重启数据丢失**。

### 第三步：配置环境变量

在 Zeabur 项目 → 你的服务 → **Variables** 中添加：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ADMIN_USERNAME` | 是 | `admin` | 管理员登录账号 |
| `ADMIN_PASSWORD` | 是 | - | 管理员登录密码（生产必须 ≥ 32 字符） |
| `SQLITE_PATH` | 否 | `/data/app/xuanji.db` | SQLite 数据库文件路径 |
| `UPLOAD_DIR` | 否 | `/data/app/uploads` | 上传文件目录 |
| `JWT_SECRET` | 否 | 自动生成 | JWT 签名密钥（建议设置随机字符串，≥ 32 字符） |
| `EGRESS_ALLOW_PRIVATE_NET` | 否 | `false` | 是否允许服务端 fetch 私网（NAS AList / 内网 LLM） |

> **不再需要**：`DATABASE_URL`（MySQL 已移除）、`ZVEC_*`（向量已并入 SQLite 扩展）。

### 第四步：登录使用

访问部署后的域名，使用配置的管理员账号密码登录。

数据库 schema 会在首次启动时自动通过 drizzle migration 应用（无需手动 `drizzle-kit push`）。

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

### 数据迁移（旧 MySQL → 新 SQLite）

如果你是从 R1/R2 的 MySQL 版本升级：

1. 旧 MySQL 仍可继续运行到 R3 之前的版本
2. 升级到 R3 后数据**不会自动迁移**——SQLite 是全新单文件
3. 如需保留数据：用 `mysqldump` 导出 → 写转换脚本（项目计划提供 `scripts/migrate-mysql-to-sqlite.ts`，本版本未交付）→ 导入到新的 SQLite 库
4. 或：临时保留旧 MySQL 实例，平行运行直到确认无关键数据

### 忘记密码
- 在 Zeabur Variables 中修改 `ADMIN_PASSWORD`
- 重新部署即可生效（SQLite 用户表里 password 字段由 ADMIN_USERNAME/ADMIN_PASSWORD 启动时同步）

### 备份

最简单的备份：直接复制 `/data/app/xuanji.db` 文件到对象存储（Zeabur 持久卷本身有快照机制）。

高级：使用应用内 **数据备份** 功能（管理员后台）支持加密打包。

### 更新部署

推送代码到 GitHub 主分支，Zeabur 自动重新构建：

```bash
git add .
git commit -m "更新描述"
git push
```

升级期间 SQLite 文件不会被破坏——drizzle migration 在表已存在时幂等跳过（`CREATE TABLE IF NOT EXISTS`）。
