# Phase 2 问题跟踪

## 待修复
- 登录无请求限流
- JWT_SECRET 可能为空或默认弱值
- 改密码后旧 JWT 仍有效
- Cookie SameSite 配置需复核
- 非 MCP 路由错误详情泄露
- hono 版本有安全警告
- Dockerfile 仍使用 root
- .env.example 有默认弱密码
