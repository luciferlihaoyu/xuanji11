# 璇玑智脑安全加固 Phase 3 计划

## TODOs
1. [x] P2: 修复 npm audit 依赖漏洞（非破坏性升级）
2. [x] P2: 增加全局安全响应头（CSP/HSTS/X-Frame-Options 等）
3. [x] P2: 全路由输入校验与注入风险复核
4. [x] P2: 运行验证（npm run check / test / build / audit）
5. [x] P2: 提交、推送并部署 Zeabur

## Final Verification Wave
F1. [x] 代码审查（manual review）
F2. [x] 自动验证（type/lint/test/build/audit）
F3. [x] 安全功能验证（响应头、输入校验）
F4. [x] 部署验证（/health、关键功能）
