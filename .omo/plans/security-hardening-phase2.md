# 璇玑智脑安全加固 Phase 2 计划

## TODOs
1. [x] P1: 认证与会话加固（登录限流、JWT Secret 强校验、改密码后吊销旧会话）
2. [x] P1: CSRF 防护与错误详情收敛（非 MCP 路由）
3. [x] P1: 依赖与运行环境加固（升级 hono、Docker 非 root、.env.example 清理）
4. [x] P1: 运行验证（npm run check / test / build）
5. [x] P1: 提交、推送并部署 Zeabur

## Final Verification Wave
F1. [x] 代码审查（manual review）
F2. [x] 自动验证（type/lint/test/build）
F3. [x] 安全功能验证（登录限流、CSRF、错误消息、Docker 用户）
F4. [x] 部署验证（/health、关键功能）
