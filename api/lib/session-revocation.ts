/**
 * t8/M4 修复：内存会话撤销表（jti 黑名单）。
 * 服务端登出后立即使 token 失效——即使 cookie 已被 XSS/共享设备拷贝/代理日志泄露。
 * 周期清理 + 容量上限（防内存泄漏）。仅本地进程有效；多副本部署需升级到 DB/Redis
 * 共享撤销表（plan 未授权升级范围）。
 */

const MAX_ENTRIES = 10_000;
/** 周期清理：删已过期条目（防 revoked Map 无限增长） */
const SWEEP_INTERVAL_MS = 60_000;

const revoked = new Map<string, number>(); // jti -> expMs（Map 保插入顺序，便于容量满时淘汰最早）
let sweeper: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [jti, exp] of revoked) {
      if (exp <= now) revoked.delete(jti);
    }
  }, SWEEP_INTERVAL_MS);
  // 不阻塞进程退出（unref）；登出/验证是请求路径上的，不该让进程被此 timer 拦着退
  sweeper.unref();
}

/**
 * 把 jti 加入黑名单，到 expMs 失效。
 * 容量满：淘汰最早加入的（Map 头）；不会因新 revoke 而失败。
 */
export function revokeJti(jti: string, expMs: number): void {
  if (revoked.size >= MAX_ENTRIES) {
    const oldest = revoked.keys().next().value;
    if (oldest !== undefined) revoked.delete(oldest);
  }
  revoked.set(jti, expMs);
  ensureSweeper();
}

/** jti 是否已被撤销。已过期条目顺手清掉。 */
export function isRevoked(jti: string | undefined): boolean {
  if (!jti) return false;
  const exp = revoked.get(jti);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    revoked.delete(jti);
    return false;
  }
  return true;
}

/** 测试探针：当前黑名单条数 */
export function __sizeForTests(): number {
  return revoked.size;
}

/** 测试探针：清空黑名单并停掉清理 timer（每个 test 前调用） */
export function __resetForTests(): void {
  revoked.clear();
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}
