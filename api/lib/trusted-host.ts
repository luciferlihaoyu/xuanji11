/**
 * 可信 Host 提取（统一 X-Forwarded-Host 解析口径）。
 *
 * 背景（审查报告 Reviewer B 残留项）：原 kimi/auth.ts:resolveRedirectUri 直接取
 * X-Forwarded-Host 首段无校验——攻击者构造 XFF 即可让 OAuth redirectUri 指向任意
 * 域（Kimi 登录后会跳回该域，配合 CSRF → state 攻击）。同理 webhook callback、
 * 任何"按 host 拼接 URL"的逻辑都应走本函数。
 *
 * 口径：
 * 1. 未配置 TRUSTED_FORWARDED_HOSTS → **不读 XFF**，返回 null（调用方回退到
 *    URL origin / 固定配置）。这是"白名单优先于隐式信任"：宁可丢失 header 也
 *    不被 XFF 伪造劫持。
 * 2. XFF 多段（链路式代理）只取首段（最左侧，由客户端最近一次写入，可被攻击者
 *    改写）。
 * 3. XFF 不在白名单 → console.warn + 返回 null（**不**静默用 XFF）。
 * 4. 白名单配置形如 "app.example.com,www.example.com"（逗号分隔，空段忽略）。
 *    大小写不敏感比较。
 *
 * 与 lib/trusted-ip.ts 的对称：trusted-ip 解决"客户端 IP"，trusted-host 解决
 * "客户端声明的 host"——两者都是反代头伪造的同一类风险，统一"白名单优先"策略。
 */
export function getTrustedForwardedHost(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (!xff) return null;
  const allowList = (process.env.TRUSTED_FORWARDED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowList.length === 0) {
    // 未配置白名单 → 不信 XFF（部署侧须显式 opt-in 才能让反代头生效）
    return null;
  }
  if (!allowList.includes(xff.toLowerCase())) {
    console.warn(`[TrustedHost] X-Forwarded-Host "${xff}" 不在 TRUSTED_FORWARDED_HOSTS 白名单内，已忽略`);
    return null;
  }
  return xff;
}

/**
 * 当前生效的"对外 host"：优先显式配置（env.WEB_URL / env.KIMI_REDIRECT_URI 等
 * 由调用方自取），否则 XFF 白名单命中，否则 null（让调用方回退到 URL origin）。
 *
 * 这是上层最常用的"三步降级"口径——单一函数避免每个调用方重写 if/else 链。
 */
export function resolveForwardedHost(req: Request): string | null {
  return getTrustedForwardedHost(req);
}
