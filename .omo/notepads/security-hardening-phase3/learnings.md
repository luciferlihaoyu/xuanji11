# Phase 3 安全加固学习笔记

## 当前上下文
- 仓库: /opt/xuanji11
- 分支: main
- 线上: https://xuanjj29.zeabur.app/
- Zeabur 项目: 6a23dcd2f1be9943f1f95ca0
- Zeabur 服务: 6a355024558aac447d432fdd

## 关键决策
- Phase 1-2 已完成 P0/P1 安全加固。
- Phase 3 处理 P2/纵深防御：依赖漏洞修复、安全响应头、输入校验复核。
- npm audit 发现 13 个漏洞（5 high, 8 moderate），优先使用 `npm audit fix` 修复非破坏性升级。
- 安全响应头通过 Hono 中间件全局设置，覆盖 `/api/*` 和静态资源。
- CSP 需要允许内联样式和脚本（Vite 构建产物使用内联 style），使用 nonce 或 strict-dynamic 不可行时采用合理策略。

## 验证命令
- npm audit --audit-level=moderate
- npm run check
- npm test
- npm run build
