import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetForTests,
  __sizeForTests,
  clearLoginFailures,
  createLoginAttempt,
  isLoginLocked,
  recordLoginFailure,
} from "./login-rate-limit";

// 与实现同步的阈值字面量（实现未导出常量，改阈值时同步更新此处）
const IP_BUCKET_LIMIT = 5; // 辅助桶：ip::username
const GLOBAL_USER_LIMIT = 20; // 全局用户名桶：与 IP 无关
const MAX_TRACKED = 10_000;
const LOCKOUT_MS = 15 * 60 * 1000;

describe("login rate limit (dual buckets)", () => {
  beforeEach(() => {
    __resetForTests();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the legacy ip-bucket lock after five failures for the same ip and username", () => {
    const t0 = 1_000_000;
    const attempt = createLoginAttempt("admin", "203.0.113.10");
    for (let i = 0; i < IP_BUCKET_LIMIT; i++) {
      recordLoginFailure(attempt, t0 + i);
    }

    expect(isLoginLocked(attempt, t0 + IP_BUCKET_LIMIT)).toBe(true);
    // 同 IP 换用户名 / 同用户名换 IP：辅助桶独立，不在全局阈值内不受影响
    expect(isLoginLocked(createLoginAttempt("other", "203.0.113.10"), t0 + 10)).toBe(false);
    expect(isLoginLocked(createLoginAttempt("admin", "203.0.113.11"), t0 + 10)).toBe(false);
  });

  it("does not lock a username below the global threshold when the attacker rotates ips", () => {
    // PLAN t1 verify 原文写「同 username 6 次换 XFF → 第 6 次锁定」，与 change 字段
    // LOGIN_GLOBAL_USER_LIMIT = 20 不一致（6 < 20 恒不触发，系旧 ip 桶阈值 5 的残留）。
    // 按 change 字段实现：6 次轮换不锁定，20 次锁定（见下一用例）。
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) {
      recordLoginFailure(createLoginAttempt("admin", `198.51.100.${i}`), t0 + i);
    }
    expect(isLoginLocked(createLoginAttempt("admin", "198.51.100.99"), t0 + 10)).toBe(false);
  });

  it("locks the global user bucket after twenty failures regardless of ip rotation (H2)", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < GLOBAL_USER_LIMIT; i++) {
      recordLoginFailure(createLoginAttempt("admin", `198.51.100.${i}`), t0 + i);
    }

    // 每个辅助桶只累积 1 次，锁定完全来自全局用户名桶
    for (let i = 0; i < GLOBAL_USER_LIMIT; i++) {
      expect(isLoginLocked(createLoginAttempt("admin", `198.51.100.${i}`), t0 + 100)).toBe(true);
    }
    // 全新 IP 也被拒：用户名维度卡死 admin 爆破
    expect(isLoginLocked(createLoginAttempt("admin", "203.0.113.77"), t0 + 100)).toBe(true);
    // 其他用户名不受牵连（桶独立）
    expect(isLoginLocked(createLoginAttempt("alice", "203.0.113.77"), t0 + 100)).toBe(false);
  });

  it("does not lock different usernames sharing one ip (independent buckets)", () => {
    const t0 = 1_000_000;
    const names = ["alice", "bob", "carol", "dave", "erin"];
    for (const name of names) {
      recordLoginFailure(createLoginAttempt(name, "203.0.113.10"), t0);
    }
    for (const name of names) {
      expect(isLoginLocked(createLoginAttempt(name, "203.0.113.10"), t0 + 1)).toBe(false);
    }
  });

  it("clears both buckets on successful login", () => {
    const t0 = 1_000_000;
    // 全局桶锁定
    for (let i = 0; i < GLOBAL_USER_LIMIT; i++) {
      recordLoginFailure(createLoginAttempt("admin", `198.51.100.${i}`), t0 + i);
    }
    expect(isLoginLocked(createLoginAttempt("admin", "198.51.100.99"), t0 + 100)).toBe(true);

    clearLoginFailures(createLoginAttempt("admin", "any-ip"));
    expect(isLoginLocked(createLoginAttempt("admin", "198.51.100.99"), t0 + 101)).toBe(false);

    // 辅助桶锁定同样被清
    for (let i = 0; i < IP_BUCKET_LIMIT; i++) {
      recordLoginFailure(createLoginAttempt("bob", "203.0.113.10"), t0 + i);
    }
    expect(isLoginLocked(createLoginAttempt("bob", "203.0.113.10"), t0 + 50)).toBe(true);
    clearLoginFailures(createLoginAttempt("bob", "203.0.113.10"));
    expect(isLoginLocked(createLoginAttempt("bob", "203.0.113.10"), t0 + 51)).toBe(false);
  });

  it("unlocks after the lockout expires", () => {
    const t0 = 1_000_000;
    // 锁定自最后一次失败起算 LOCKOUT_MS，过期检查点需晚于「最后失败 + 锁时长」
    const afterLock = LOCKOUT_MS + 60_000;
    const attempt = createLoginAttempt("admin", "203.0.113.10");
    for (let i = 0; i < IP_BUCKET_LIMIT; i++) {
      recordLoginFailure(attempt, t0 + i);
    }
    expect(isLoginLocked(attempt, t0 + 1_000)).toBe(true);
    expect(isLoginLocked(attempt, t0 + afterLock)).toBe(false);

    // 全局桶同理：20 次轮换锁定，锁过期后放行
    __resetForTests();
    for (let i = 0; i < GLOBAL_USER_LIMIT; i++) {
      recordLoginFailure(createLoginAttempt("admin", `198.51.100.${i}`), t0 + i);
    }
    expect(isLoginLocked(createLoginAttempt("admin", "9.9.9.9"), t0 + 100)).toBe(true);
    expect(isLoginLocked(createLoginAttempt("admin", "9.9.9.9"), t0 + afterLock)).toBe(false);
  });

  it("restarts the ip-bucket count after the failure window passes", () => {
    const t0 = 1_000_000;
    const attempt = createLoginAttempt("admin", "203.0.113.10");
    for (let i = 0; i < IP_BUCKET_LIMIT - 1; i++) {
      recordLoginFailure(attempt, t0 + i);
    }
    // 窗口（5 分钟）外的失败重新计数，不与旧次数累计触发锁定
    recordLoginFailure(attempt, t0 + 5 * 60 * 1000 + 1_000);
    expect(isLoginLocked(attempt, t0 + 5 * 60 * 1000 + 1_001)).toBe(false);
  });

  it("caps the tracked map size beyond MAX_TRACKED (M8)", () => {
    const t0 = 1_000_000;
    // victim：19 次轮换失败（差 1 次到全局阈值），之后不再更新 → 最久未活跃
    for (let i = 0; i < GLOBAL_USER_LIMIT - 1; i++) {
      recordLoginFailure(createLoginAttempt("victim", `198.51.100.${i}`), t0 + i);
    }
    expect(isLoginLocked(createLoginAttempt("victim", "198.51.100.200"), t0 + 100)).toBe(false);

    // 洪水：超过容量上限的大量伪造键
    for (let i = 0; i < MAX_TRACKED + 500; i++) {
      recordLoginFailure(createLoginAttempt(`flood${i}`, `203.0.113.${i % 256}`), t0 + 200 + i);
    }

    // Map 容量不爆（硬上限 MAX_TRACKED）
    expect(__sizeForTests()).toBeLessThanOrEqual(MAX_TRACKED);

    // victim 已按「最久未活跃」驱逐：计数从头开始，再 1 次不会到阈值 20
    recordLoginFailure(createLoginAttempt("victim", "198.51.100.250"), t0 + 20_000);
    expect(isLoginLocked(createLoginAttempt("victim", "198.51.100.251"), t0 + 20_001)).toBe(false);
  });

  it("never evicts a locked bucket to make room for a failure flood (P3 复核)", () => {
    const t0 = 1_000_000;
    // 1) admin 全局桶锁定（20 次轮换 IP 失败）
    for (let i = 0; i < GLOBAL_USER_LIMIT; i++) {
      recordLoginFailure(createLoginAttempt("admin", `198.51.100.${i}`), t0 + i);
    }
    expect(isLoginLocked(createLoginAttempt("admin", "203.0.113.200"), t0 + 100)).toBe(true);

    // 2) 洪水：MAX_TRACKED + 500 个随机用户名各失败一次。local-auth 对非 admin 用户名
    //    不做 bcrypt 比对直接记失败，攻击者可秒级造出万级记录 —— 这正是绕过 H2 的手段：
    //    Map 被撑过 MAX_TRACKED 时，旧实现按插入顺序把锁定中的 `username:admin` 挤出队头，
    //    锁定与计数一并消失，攻击者重新获得 20 次爆破额度，可无限循环。
    for (let i = 0; i < MAX_TRACKED + 500; i++) {
      recordLoginFailure(createLoginAttempt(`flood${i}`, `203.0.113.${i % 256}`), t0 + 200 + i);
    }

    // 3) 锁定中的 admin 桶必须存活（修复前此断言失败）
    expect(isLoginLocked(createLoginAttempt("admin", "203.0.113.201"), t0 + 100_000)).toBe(true);

    // 容量仍受控：豁免只针对锁定条目，未锁定条目照旧被驱逐（M8 硬上限不被破坏）
    expect(__sizeForTests()).toBeLessThanOrEqual(MAX_TRACKED);
  });
});
