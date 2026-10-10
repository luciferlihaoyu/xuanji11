# 璇玑部署通告 v1（安全修复 P0-P2 + M5）

> **适用版本**：`464aad8` 及之后
> **受众**：部署/运维
> **汇总**：四批次安全修复累计 13 项行为变化、4 个环境变量关注点。**标 🔴 的项不处理会导致功能故障**，其余为行为收紧或建议。

---

## 一、🔴 必须处理的部署项

### 1. 反代部署必须设置 `TRUSTED_FORWARDED_HOSTS`（P2 新增）

```bash
TRUSTED_FORWARDED_HOSTS=app.example.com,www.example.com   # 逗号分隔，大小写不敏感
```

**不设的后果**：`X-Forwarded-Host` 一律不被信任（最严默认），OAuth callback URL 退化到请求 URL origin——开发环境（localhost）无感，**生产反代下 Kimi 登录会失败**。

**背景**：修复 XFF 伪造可劫持 OAuth redirectUri 的高危链（kimi/auth.ts）。白名单命中的 host 才参与 callback 拼接。

### 2. 部署后管理员需重新复制 webhook URL/Token（P1 行为变化）

webhook token 已绑定 `workflow.updatedAt`（改工作流即换 token，轮换成本从"必须改 jwtSecret"降到"随便改个名字"）。**升级部署后，所有已配置的外部 webhook 调用方会 403**——需到 WorkflowBuilder 重新复制 URL，且**优先用 `X-Webhook-Token` header**（`?token=` query 仍兼容但打弃用 warn，token 落 URL 会进代理日志/Referer/浏览器历史）。

### 3. 启用 Kimi OAuth 的部署：callback 需配套发起端点（P0 行为变化）

若已配 `APP_ID`/`APP_SECRET`：state 现在要求一次性校验（防登录 CSRF），callback 携带旧格式/伪造 state 一律 400。外部若硬编码过 OAuth 入口链接，需改用应用内发起的 `/api/kimi/auth/start`（以代码实际路由为准）。

---

## 二、⚠️ 行为变化（需告知用户/确认拓扑）

### 4. viewer / OAuth 非 owner 用户从全权变只读（P0 t4 目标行为）

写操作返回 403。这是修复"多用户场景凭据泄露链"的预期收紧，不是故障。

### 5. `/api/mcp` 不再接受 cookie 会话（P0 t5）

仅认 `Authorization: Bearer <agent-token>`。AI 中心调试面板需手填 Bearer。逃生口：`MCP_ALLOW_SESSION=1` 显式恢复（默认关，仅限完全内网部署）。

### 6. 登出后服务端立即撤销 token（P1 t8）

XSS/共享设备拷贝的 cookie 登出后立刻 401（不再活到 exp）。**长期持有 cookie 的脚本/集成在登出后需重新登录**。浏览器用户无感。

### 7. 备份 `sourcePath` 相对路径白名单（P0 t3）

`bundle`/`database`/`knowledge` 之外的自定义相对路径被拒（防路径穿越）。有自定义备份源的部署需改为绝对路径或白名单内别名。

### 8. `TIANSHU_BASE_URL` 指向内网将被出口策略拒绝（P2 L2）

天枢模型列表拉取已走 `safeFetch`（DNS 钉死 + egress 校验）。内网天枢部署需显式：

```bash
EGRESS_ALLOW_PRIVATE_NET=true   # 默认 false；放行 = 部署侧显式决策
```

### 9. admin 登录限流的公网 DoS 面（P0 t1，未改码）

公网反代下攻击者可故意输错 20 次把 admin 锁 15 分钟（全局用户名桶）。**纯内网部署无此面**；公网部署建议：反代层先做限速，或调大 `LOGIN_GLOBAL_USER_LIMIT`（环境变量，若已支持）。

### 10. RSS 中文源解码依赖 Node full-icu（P1 t7，部署检查项）

标准 docker Node 镜像已含 full-icu；**alpine/精简镜像需确认** `node -e "new TextDecoder('gbk')"` 不抛错，否则 GBK 源仍乱码。

---

## 三、备份体系（M5 补修，`464aad8`）

### 11. 新备份为 v2 格式，存量备份永久可解

- v2 密文：`MAGIC("XJBK") + kdfId + salt + iv + tag + ct`，密钥 **scrypt** 派生（N=2¹⁵）
- v1 存量（SHA-256 派生）：解密按版本头自动分流，**用原 `BACKUP_ENCRYPTION_KEY` 永久可解**（有兼容锁测试兜底）
- `BACKUP_ENCRYPTION_KEY` 建议 32+ 随机串；弱密钥（<16 字符）加密时打 warn（不硬拒）
- `/115/璇玑备份/` 09-17 旧批系废弃钥加密（与本次无关，勿当可用备份——AGENTS.md 既有口径）

---

## 四、环境变量速查

| 变量 | 必设? | 说明 |
|---|---|---|
| `TRUSTED_FORWARDED_HOSTS` | 🔴 反代必设 | XFF host 白名单，逗号分隔 |
| `BACKUP_ENCRYPTION_KEY` | 已配则不动 | 建议 32+ 随机串；存量备份靠它解密，**换钥 = 存量备份作废** |
| `EGRESS_ALLOW_PRIVATE_NET` | 内网服务才设 | `true` 放行内网出网（天枢内网网关等） |
| `MCP_ALLOW_SESSION` | 不建议设 | `1` 恢复 MCP cookie 会话（默认关） |

---

## 五、升级操作顺序建议

1. 备份当前数据库（旧版本代码跑一次全量备份，确认产物可解密）
2. 拉取 `464aad8` 重建/重启
3. 设置 `TRUSTED_FORWARDED_HOSTS`（反代部署）后重启
4. 验证：登录 → 打开工作流页复制新 webhook URL → 触发一次 Kimi 登录 → 手动触发一次备份并确认日志无弱密钥 warn
5. 旧备份抽一个跑 restore 演练（验证 v1 兼容解密）

---

*配套审查报告：`璇玑代码全面审查报告-碧霄-v2.md`；历史通告见 P0/P1/P2/M5 commit message。*
