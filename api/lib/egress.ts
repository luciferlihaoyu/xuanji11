/**
 * SSRF egress guard：所有以「用户/租户可控 URL」发起的服务端 fetch 必须前置
 * assertEgressAllowed（或直接使用 safeFetch）。
 *
 * 默认拒绝解析到私网/环回/链路本地/metadata 的地址；自托管内网部署（如 NAS 上的
 * AList、内网 LLM 网关）可通过环境变量 EGRESS_ALLOW_PRIVATE_NET=true 显式放行。
 */

export class EgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressError";
  }
}

export type ResolveHost = (host: string) => Promise<string[]>;

const defaultResolveHost: ResolveHost = async (host) => {
  const dns = await import("node:dns");
  const records = await dns.promises.lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

let activeResolveHost: ResolveHost = defaultResolveHost;

/** 测试注入用：替换 DNS 解析器。 */
export function setResolveHostForTests(resolver: ResolveHost): void {
  activeResolveHost = resolver;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** 判定单个地址是否属于被禁止网段。 */
export function isBlockedAddress(address: string): boolean {
  let ip = address.trim().toLowerCase();
  // IPv4-mapped IPv6（::ffff:a.b.c.d）
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];

  if (ip.includes(":")) {
    // IPv6
    if (ip === "::1" || ip === "::") return true;
    const compact = expandIpv6(ip);
    if (!compact) return false;
    if (compact.startsWith("fe80")) return true; // link-local fe80::/10
    if (/^f[cd]/.test(compact)) return true; // ULA fc00::/7
    return false;
  }

  // IPv4
  if (ipv4ToInt(ip) === null) return true; // 非 IP 字符串视为无效拒绝
  return (
    inCidr4(ip, "127.0.0.0", 8) ||
    inCidr4(ip, "10.0.0.0", 8) ||
    inCidr4(ip, "172.16.0.0", 12) ||
    inCidr4(ip, "192.168.0.0", 16) ||
    inCidr4(ip, "169.254.0.0", 16) ||
    inCidr4(ip, "0.0.0.0", 8) ||
    inCidr4(ip, "100.64.0.0", 10)
  );
}

function expandIpv6(ip: string): string | null {
  if (!/^[0-9a-f:]+$/.test(ip)) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const tail = halves[1] !== undefined ? (halves[1] ? halves[1].split(":").filter(Boolean) : []) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  return groups.join("");
}

/** 自托管内网部署显式放行开关。
 * 优先读系统设置表 (systemSettings.key='egress_allow_private_net')，其次环境变量兜底。
 * 管理员可在设置页「安全」tab 直接开关，无需重启/重新部署。
 * 60s 缓存，避免每次外呼都查 DB。 */
let cachedPolicy: { allowed: boolean; expiresAt: number } | null = null;
const POLICY_CACHE_TTL_MS = 60_000;

export type EgressPolicyProvider = () => Promise<boolean>;

const defaultPolicyProvider: EgressPolicyProvider = async () => {
  // 1) 系统设置表（管理员在设置页开关）
  try {
    const { getDb } = await import("../queries/connection");
    const { systemSettings } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    const [row] = await db.select({ value: systemSettings.value }).from(systemSettings)
      .where(eq(systemSettings.key, "egress_allow_private_net"));
    if (row?.value === "true" || row?.value === "1") return true;
    if (row?.value === "false" || row?.value === "0") return false;
  } catch {
    // DB 不可用时（如启动早期）回退到环境变量
  }
  // 2) 环境变量兜底（兼容旧部署）
  return process.env.EGRESS_ALLOW_PRIVATE_NET === "true";
};

let activePolicyProvider: EgressPolicyProvider = defaultPolicyProvider;

/** 测试/启动期注入：替换策略来源。 */
export function setEgressPolicyForTests(provider: EgressPolicyProvider): void {
  activePolicyProvider = provider;
  cachedPolicy = null;
}

/** 判定是否允许私网出网（管理员显式放行）。 */
export async function isPrivateNetAllowed(): Promise<boolean> {
  if (cachedPolicy && cachedPolicy.expiresAt > Date.now()) return cachedPolicy.allowed;
  const allowed = await activePolicyProvider();
  cachedPolicy = { allowed, expiresAt: Date.now() + POLICY_CACHE_TTL_MS };
  return allowed;
}

/** 校验通过的 host 短期缓存（秒级 TTL）：alist 列目录等低频但连续的外呼免重复 DNS。 */
const passCache = new Map<string, number>();
const PASS_CACHE_TTL_MS = 60_000;

/**
 * 校验 URL 允许出网：
 * - 协议必须为 http/https；
 * - hostname 为 IP 字面量时直接判定；
 * - 否则 DNS 解析后对全部地址判定（任一命中即拒绝，防多记录绕过）；
 * - EGRESS_ALLOW_PRIVATE_NET=true 时跳过私网判定（自托管内网部署）。
 */
export async function assertEgressAllowed(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EgressError(`egress blocked: invalid url`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EgressError(`egress blocked: unsupported protocol ${parsed.protocol}`);
  }
  if (await isPrivateNetAllowed()) return;

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const cachedAt = passCache.get(host);
  if (cachedAt && Date.now() - cachedAt < PASS_CACHE_TTL_MS) return;

  const addresses = /^[0-9a-f:.]+$/i.test(host) && host.includes(":")
    ? [host]
    : host.match(/^\d{1,3}(\.\d{1,3}){3}$/)
      ? [host]
      : await activeResolveHost(host).catch(() => {
          throw new EgressError(`egress blocked: cannot resolve host`);
        });

  if (addresses.length === 0) {
    throw new EgressError(`egress blocked: cannot resolve host`);
  }
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new EgressError(`egress blocked: private or blocked address`);
    }
  }
  passCache.set(host, Date.now());
}
