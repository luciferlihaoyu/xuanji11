import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Kimi OAuth state 参数签发/消费（H4 修复，PLAN-安全修复-v1 t4）。
 *
 * 历史 bug：callback 侧把 `state` 当作 base64 编码的 redirectUri 使用
 * （`atob(state)`），既不做防伪造校验，又让攻击者能借 state 把
 * token exchange 的 redirect_uri 指向任意值。
 *
 * 修复后语义：
 * - `state` 是服务端签发的一次性 32B 高熵随机值（base64url）；
 * - callback 侧必须 `consumeOAuthState` 命中才算合法回调（防 CSRF/伪造）；
 * - redirectUri 改为固定来源（env / 请求推算），与 state 解耦。
 *
 * 注意：发起端点（构造 authorize URL 并注入 state）在当前代码库中
 * 不存在（OAuth 未启用，boot.ts 仅在 APP_ID/APP_SECRET 配置时挂载
 * callback）。若未来补上发起侧，必须调用 `issueOAuthState()` 生成 state。
 */

const STATE_TTL_MS = 10 * 60 * 1000; // 10 分钟内完成 OAuth 往返
const MAX_PENDING_STATES = 1000;

/** key = state 原值；value = 签发时间。Map 插入序天然提供 LRU 淘汰序。 */
const pendingStates = new Map<string, { state: string; issuedAt: number }>();

/** 签发一个一次性 OAuth state（32B base64url，高熵不可预测）。 */
export function issueOAuthState(): string {
  const state = randomBytes(32).toString("base64url");
  pendingStates.set(state, { state, issuedAt: Date.now() });
  if (pendingStates.size > MAX_PENDING_STATES) {
    // 超上限时按最旧优先驱逐（Map 迭代序 = 插入序）
    for (const oldest of pendingStates.keys()) {
      pendingStates.delete(oldest);
      if (pendingStates.size <= MAX_PENDING_STATES) break;
    }
  }
  return state;
}

/** 常数时间字符串比较（长度不同时也执行一次比较，抹平可测量时间差）。 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * 消费一个 OAuth state：命中且未过期返回 true，并立即删除（一次性）。
 * 未命中 / 已消费 / 已过期（TTL 10min）均返回 false。
 */
export function consumeOAuthState(candidate: string): boolean {
  const entry = pendingStates.get(candidate);
  if (!entry) {
    // 未命中也走一次常数时间比较，避免命中/未命中形成可测分支差
    constantTimeEqual(candidate, candidate);
    return false;
  }
  pendingStates.delete(candidate); // 消费即删，杜绝重放
  if (Date.now() - entry.issuedAt > STATE_TTL_MS) return false;
  return constantTimeEqual(candidate, entry.state);
}

/** 测试辅助：清空待消费 state 表。 */
export function __resetForTests(): void {
  pendingStates.clear();
}
