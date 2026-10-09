/**
 * 可信客户端 IP 提取（登录限流专用口径）。
 *
 * 背景（审查报告 H2）：旧实现取 XFF 首段，而 XFF 首段由客户端任意伪造
 * （客户端→CDN→源站链路中攻击者自带的 XFF 保留在最前），导致
 * `clientIp::username` 限流键永不累积，admin 密码可被无限速爆破。
 *
 * 口径：XFF 链路（client, proxy1, proxy2）中越靠右的条目越接近我方可信
 * 代理（由它追加、客户端不可改写）。因此从右往左扫描，跳过内网/环回/
 * 链路本地段（复用 egress.ts 的 isBlockedAddress，避免双实现），取第一个
 * 非内网候选作为客户端 IP；XFF 全内网或缺失时回退 x-real-ip，再无则
 * "unknown"。
 *
 * 残余风险说明：无追加代理的直连场景下 XFF 可整体伪造，IP 维度限流仍可能
 * 被轮换绕过——该残余由 login-rate-limit.ts 的全局用户名桶兜底（同用户名
 * 失败计数与 IP 无关）。
 */
import { isBlockedAddress } from "./egress";

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 候选是否为 IP 字面量（IPv4 点分十进制，或含冒号的 IPv6）。 */
function looksLikeIpLiteral(candidate: string): boolean {
  return IPV4_LITERAL.test(candidate) || candidate.includes(":");
}

/** 候选是否属于内网/环回/链路本地等不应作为客户端标识的网段。
 *  网段判定复用 egress.isBlockedAddress；非 IP 字面量（如伪造的 "fake"）
 *  不属于任何内网段，不在此跳过——交由上层作为普通候选参与限流键，
 *  轮换残余风险由全局用户名桶兜底。 */
function isInternalHop(candidate: string): boolean {
  if (!looksLikeIpLiteral(candidate)) return false;
  return isBlockedAddress(candidate);
}

export function getTrustedClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const candidates = forwardedFor
      .split(",")
      .map((entry) => entry.trim().replace(/^\[|\]$/g, ""))
      .filter(Boolean);
    // 从右往左：第一个非内网候选即可信客户端 IP（右段由最近的可信代理追加）
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (!isInternalHop(candidates[i])) return candidates[i];
    }
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
