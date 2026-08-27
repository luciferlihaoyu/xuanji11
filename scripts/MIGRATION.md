# MySQL → SQLite 迁移工具

## 用途
把 R1/R2 时期部署在 Zeabur MySQL 上的 xuanji 数据迁移到 R3 的单文件 SQLite 库。

## 用法
```bash
# 1. 从旧 MySQL 拉取 mysqldump
mysqldump -u root -p --single-transaction --skip-lock-tables \
  --routines --triggers --default-character-set=utf8mb4 zeabur > dump.sql

# 2. 跑迁移
node scripts/migrate-mysql-dump.mjs dump.sql xuanji.db

# 3. 验证行数（脚本会输出）
```

## 脚本逻辑
1. 跑 R3 `db/migrations/0000_*.sql` 建表结构（25 张表，含 `__drizzle_migrations`）
2. 解析 mysqldump 的 `INSERT INTO \`table\` VALUES (...);`
3. 解析 MySQL `CREATE TABLE` 拿列顺序
4. 按 R3 `db/schema.ts` 列顺序重排数据（`users`/`backup_jobs`/`workflows` 三张表列顺序不同）
5. 类型转换：timestamp 字符串 `'YYYY-MM-DD HH:MM:SS'` → unix ms 整数
6. 用 `INSERT INTO table (col, col, ...) VALUES (?,?,...)` 显式列名

## 跳过表
- 22 张 R3 schema 共有表 → 迁移
- `model_pricing` / `model_allowlist` / `messages` / `tasks` / `task_*` / `conversations` / `organizations` / `departments` / `high_cost_model_auth` / `systems` / `token_usage` / `workflow_executions` / `mcp_*` / `mailbox_messages` / `github_*` → 跳过（R3 删了或用户不用）

## 字段类型映射
| MySQL | R3 SQLite |
|---|---|
| `bigint unsigned` | `integer primary key autoincrement` |
| `varchar(N)` | `text` |
| `text` | `text` |
| `json` | `text (mode: json)` |
| `timestamp` | `integer (mode: timestamp_ms)` — 自动转换 |
| `tinyint(1)` | `integer (mode: boolean)` |
| `int` | `integer` |
| `float` | `real` |
| `enum` | `text (enum: [...])` |

## 不迁移的内容
- **向量 embedding 数据**（`document_chunks.embedding` 全部 NULL，原部署未启用 zvec 引擎）
  - 部署后第一次启动时，应用层会触发全量 re-embedding
- **旧版 zvec 文件系统**（`/data/app/zvec/`）
- **`mcp_servers` 表**（R3 schema 自带默认空表）

## 验证（基于真实 MySQL 数据集）
| 表 | MySQL count(*) | SQLite count(*) | 一致 |
|---|---|---|---|
| users | 1 | 1 | ✓ |
| agents | 4 | 4 | ✓ |
| document_chunks | 41450 | 41450 | ✓ |
| kb_documents | 1755 | 1755 | ✓ |
| knowledge_nodes | 155 | 155 | ✓ |
| knowledge_edges | 357 | 357 | ✓ |
| system_settings | 18 | 18 | ✓ |
| ... 其余 15 张表 | 0-56 | 0-56 | ✓ |
| **合计** | **43859 行** | **43859 行** | ✓ |

注意：`information_schema.tables.table_rows` 是 MySQL 引擎估算值（不准确），脚本用 `SELECT count(*)` 精确数对比。

## 部署到 Zeabur 后
1. 把 `xuanji.db` 上传/挂载到 `/data/app/xuanji.db`（Zeabur 持久卷）
2. 启动 xuanji 服务（用 R3 镜像）
3. 首次启动会自动：
   - 检测 SQLite 文件存在
   - 跳过 drizzle migration（CREATE TABLE IF NOT EXISTS）
   - 管理员账号 ADMIN_USERNAME/ADMIN_PASSWORD 重置（覆盖 `system_settings.admin_password_hash`）
4. 触发 embedding 重建：管理员后台 → 知识库 → 全量重建索引
