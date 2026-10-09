/**
 * 登录失败限流（双桶）。
 *
 * H2/M8 修复（PLAN-安全修复-v1 t1）：
 * - 辅助桶 `ip::username`：沿用旧口径（LOGIN_FAILURE_LIMIT 次 / LOGIN_FAILURE_WINDOW_MS）。
 *   IP 由 local-auth 的 getClientIp 经 lib/trusted-ip 可信解析得到，XFF 首段伪造不再生效；
 * - 全局用户名桶 `username:<name>`：与 IP 无关，LOGIN_GLOBAL_USER_LIMIT 次 /
 *   LOGIN_GLOBAL_USER_WINDOW_MS——攻击者轮换 IP（或直连场景整体伪造 XFF）也无法绕过，
 *   admin 密码爆破在此维度被卡死；正常用户误输不会触发（20 次/15 分钟）；
 * - 任一桶锁定即拒（isLoginLocked），登录成功清两桶（clearLoginFailures）；
 * - Map 容量 MAX_TRACKED 硬上限（超出驱逐最久未活跃条目，**锁定中的桶豁免**——否则
 *   洪水可把锁定中的桶挤出，见 enforceCapacity）+ 1 分钟周期清理（unref）。
 */

const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;

const LOGIN_GLOBAL_USER_LIMIT = 20;
const LOGIN_GLOBAL_USER_WINDOW_MS = 15 * 60 * 1000;

const MAX_TRACKED = 10_000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// 周期清理的超容驱逐门槛：超容 5% 才驱逐未过期条目（插入路径已有硬上限，此处兜底）
const SWEEP_CAPACITY_HEADROOM = 1.05;

type LoginFailureRecord = {
  readonly count: number;
  readonly firstFailureAt: number;
  readonly windowMs: number;
  readonly lockedUntil: number | null;
};

export type LoginAttempt = {
  readonly username: string;
  readonly clientIp: string;
  readonly key: string;
};

const loginFailures = new Map<string, LoginFailureRecord>();

export function createLoginAttempt(username: string, clientIp: string): LoginAttempt {
  return {
    username,
    clientIp,
    key: `${clientIp}::${username.trim().toLowerCase()}`,
  };
}

/** 全局用户名桶键：与 IP 无关，只按规范化用户名聚合。 */
function globalUserKey(username: string): string {
  return `username:${username.trim().toLowerCase()}`;
}

function bucketKeys(attempt: LoginAttempt): readonly string[] {
  return [attempt.key, globalUserKey(attempt.username)];
}

function isBucketLocked(key: string, now: number): boolean {
  const record = loginFailures.get(key);
  if (!record) return false;
  if (record.lockedUntil && record.lockedUntil > now) return true;
  if (record.lockedUntil || now - record.firstFailureAt > record.windowMs) {
    loginFailures.delete(key);
  }
  return false;
}

export function isLoginLocked(attempt: LoginAttempt, now = Date.now()): boolean {
  return bucketKeys(attempt).some((key) => isBucketLocked(key, now));
}

function recordFailureInBucket(
  key: string,
  limit: number,
  windowMs: number,
  describe: string,
  now: number,
): void {
  const current = loginFailures.get(key);
  const withinWindow = current ? now - current.firstFailureAt <= windowMs : false;
  const count = withinWindow && current ? current.count + 1 : 1;
  const firstFailureAt = withinWindow && current ? current.firstFailureAt : now;
  const lockedUntil = count >= limit ? now + LOGIN_LOCKOUT_MS : null;
  // delete+set：刷新插入顺序，最近活跃的条目排到 Map 尾部（驱逐从头部取最久未活跃）
  loginFailures.delete(key);
  loginFailures.set(key, { count, firstFailureAt, windowMs, lockedUntil });
  if (lockedUntil) {
    console.warn(`[Local Auth] Login locked for ${describe}`);
  }
}

export function recordLoginFailure(attempt: LoginAttempt, now = Date.now()): void {
  recordFailureInBucket(
    attempt.key,
    LOGIN_FAILURE_LIMIT,
    LOGIN_FAILURE_WINDOW_MS,
    `${attempt.clientIp}::${attempt.username} (ip bucket)`,
    now,
  );
  recordFailureInBucket(
    globalUserKey(attempt.username),
    LOGIN_GLOBAL_USER_LIMIT,
    LOGIN_GLOBAL_USER_WINDOW_MS,
    `${attempt.username.trim().toLowerCase()} (global user bucket)`,
    now,
  );
  enforceCapacity(MAX_TRACKED, now);
}

export function clearLoginFailures(attempt: LoginAttempt): void {
  for (const key of bucketKeys(attempt)) {
    loginFailures.delete(key);
  }
}

/**
 * 驱逐最久未活跃条目，直到条目数不超过 maxEntries。
 *
 * **锁定中的条目豁免驱逐**（复核发现的绕过路径）：旧实现从 Map 队头无差别驱逐，
 * 于是 H2 修复可被这样绕开——攻击者对 admin 失败 20 次锁定全局桶后，改用海量
 * 随机用户名各失败 1 次（local-auth 对非 admin 用户名不做 bcrypt 比对，秒级可造
 * 万级记录），Map 被撑过 MAX_TRACKED 时按插入顺序把锁定中的 `username:admin`
 * 挤出——锁定与计数一并消失，攻击者重新获得 20 次爆破额度，可无限循环。
 * 豁免锁定条目后，锁定期内该桶无法被容量机制摘除。
 *
 * 兜底：若锁定条目本身已超过 MAX_TRACKED 的 2 倍（需约 40 万次失败才能造出，
 * 攻击者代价极高），则内存安全优先于个别锁定的完整性，按插入顺序强制驱逐。
 */
function enforceCapacity(maxEntries: number, now: number): void {
  if (loginFailures.size <= maxEntries) return;
  // 第一轮：只驱逐未锁定条目（Map 迭代按插入顺序，即最久未活跃在前）
  for (const [key, record] of loginFailures) {
    if (loginFailures.size <= maxEntries) return;
    const locked = record.lockedUntil !== null && record.lockedUntil > now;
    if (!locked) loginFailures.delete(key);
  }
  // 第二轮：锁定条目占比过高时的硬顶兜底（正常路径不可达）
  const hardCap = maxEntries * 2;
  while (loginFailures.size > hardCap) {
    const oldest = loginFailures.keys().next().value;
    if (oldest === undefined) break;
    loginFailures.delete(oldest);
  }
}

/** 周期清理：删过期（锁过期或计数窗口超时）条目；超容 5% 时驱逐最旧。 */
function sweepExpired(now: number): void {
  for (const [key, record] of loginFailures) {
    const lockActive = record.lockedUntil !== null && record.lockedUntil > now;
    if (lockActive) continue;
    if (record.lockedUntil !== null || now - record.firstFailureAt > record.windowMs) {
      loginFailures.delete(key);
    }
  }
  if (loginFailures.size > Math.floor(MAX_TRACKED * SWEEP_CAPACITY_HEADROOM)) {
    enforceCapacity(MAX_TRACKED, now);
  }
}

const sweepTimer = setInterval(() => sweepExpired(Date.now()), SWEEP_INTERVAL_MS);
sweepTimer.unref();

/** 测试用：清空限流状态。 */
export function __resetForTests(): void {
  loginFailures.clear();
}

/** 测试用：观测 Map 容量（验证 MAX_TRACKED 不爆，M8 用例）。 */
export function __sizeForTests(): number {
  return loginFailures.size;
}
