import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

// 启动时检查必填环境变量
const requiredEnvVars = ["ADMIN_USERNAME", "ADMIN_PASSWORD"];

/** 从历史 DATABASE_URL 协议中提取 SQLite 文件路径（向后兼容）。 */
function deriveSqlitePathFromLegacyUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith("file:")) {
    // 兼容 "file:/data/xuanji.db?param=..." 与 "file:./xuanji.db"
    const path = url.slice("file:".length).split("?")[0] ?? "";
    if (path.length > 0) return path;
  }
  return "/data/app/xuanji.db";
}
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`❌ 缺少必填环境变量: ${key}，请在 .env 或 Zeabur 环境变量中配置`);
    process.exit(1);
  }
}

/**
 * JWT_SECRET 解析：显式配置优先；未配置时生成一次并持久化到挂载卷
 * （ZVEC_DATA_DIR 同级 .jwt-secret，0600），重启复用——避免进程随机密钥
 * 导致重启后所有会话失效、legacy scrypt 密码盐漂移。持久化失败回退进程随机。
 */
function loadOrCreateJwtSecret(): string {
  const configured = process.env.JWT_SECRET;
  if (configured) return configured;
  try {
    // SQLite 文件所在目录同级 .jwt-secret（与 SQLite 同卷持久化），单容器部署时与 DB 同生共死
    const dataDir = path.dirname(process.env.SQLITE_PATH ?? "/data/app/xuanji.db");
    const secretFile = path.join(dataDir, ".jwt-secret");
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing.length >= 32) return existing;
    const generated = randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn(`⚠️ 未设置 JWT_SECRET，已生成并持久化到 ${secretFile}（建议改为环境变量固定配置）`);
    return generated;
  } catch (err) {
    console.warn("⚠️ 未设置 JWT_SECRET 且持久化失败，使用进程随机密钥（重启后所有会话失效）:", err instanceof Error ? err.message : err);
    return randomBytes(32).toString("hex");
  }
}

const configuredJwtSecret = process.env.JWT_SECRET;
const jwtSecret = loadOrCreateJwtSecret();
if (process.env.NODE_ENV === "production" && (!configuredJwtSecret || configuredJwtSecret.length < 32)) {
  console.error("❌ 生产环境必须配置长度至少 32 字符的 JWT_SECRET");
  process.exit(1);
}
if (!configuredJwtSecret) {
  console.warn("⚠️ 未设置 JWT_SECRET（已按持久化策略处理，见上方日志）");
}

export const env = {
  // 本地管理员认证（替代 Kimi OAuth）
  adminUsername: process.env.ADMIN_USERNAME!,
  adminPassword: process.env.ADMIN_PASSWORD!,
  jwtSecret,

  // Kimi OAuth（可选，留空则禁用）
  appId: process.env.APP_ID ?? "",
  appSecret: process.env.APP_SECRET ?? "",
  kimiAuthUrl: process.env.KIMI_AUTH_URL ?? "https://auth.kimi.com",
  kimiOpenUrl: process.env.KIMI_OPEN_URL ?? "https://open.kimi.com",
  ownerUnionId: process.env.OWNER_UNION_ID ?? "",

  // 数据库（SQLite 单文件，向量通过 sqlite-vec 扩展；DATABASE_URL 仅作历史兼容）
  sqlitePath: process.env.SQLITE_PATH ?? deriveSqlitePathFromLegacyUrl(),
  databaseUrl: process.env.DATABASE_URL ?? "",

  // 持久化存储
  uploadDir: process.env.UPLOAD_DIR ?? "/data/app/uploads",
  backupTempDir: process.env.BACKUP_TEMP_DIR ?? "/data/app/backups",
  backupEncryptionKey: process.env.BACKUP_ENCRYPTION_KEY ?? "",
  // 旧名 ZVEC_* 保留兼容（向量已并入 SQLite 扩展，不再单独存储目录）
  zvecDataDir: process.env.ZVEC_DATA_DIR ?? path.dirname(process.env.SQLITE_PATH ?? "/data/app/xuanji.db"),
  zvecDimension: parseInt(process.env.ZVEC_DIMENSION ?? "1536", 10) || 1536,
  zvecEnabled: process.env.ZVEC_ENABLED !== "false",

  // 环境
  isProduction: process.env.NODE_ENV === "production",
};

/**
 * SSRF egress guard 开关：默认拒绝服务端 fetch 私网/环回地址。
 * 自托管内网部署（NAS 上的 AList、内网 LLM 网关等）设为 "true" 显式放行。
 */
export function isPrivateNetAllowed(): boolean {
  return process.env.EGRESS_ALLOW_PRIVATE_NET === "true";
}
