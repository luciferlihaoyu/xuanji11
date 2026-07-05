import "dotenv/config";
import { randomBytes } from "crypto";

// 启动时检查必填环境变量
const requiredEnvVars = ["ADMIN_USERNAME", "ADMIN_PASSWORD", "DATABASE_URL"];
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`❌ 缺少必填环境变量: ${key}，请在 .env 或 Zeabur 环境变量中配置`);
    process.exit(1);
  }
}

// JWT 密钥：未设置时自动生成随机密钥
const jwtSecret = process.env.JWT_SECRET ?? process.env.APP_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET && !process.env.APP_SECRET) {
  console.warn("⚠️ 未设置 JWT_SECRET，已自动生成随机密钥（重启后失效，建议在环境变量中固定配置）");
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

  // 数据库
  databaseUrl: process.env.DATABASE_URL ?? "",

  // 持久化存储
  uploadDir: process.env.UPLOAD_DIR ?? "/data/app/uploads",
  backupTempDir: process.env.BACKUP_TEMP_DIR ?? "/data/app/backups",
  zvecDataDir: process.env.ZVEC_DATA_DIR ?? "/data/app/zvec",
  zvecDimension: parseInt(process.env.ZVEC_DIMENSION ?? "1536", 10) || 1536,
  zvecEnabled: process.env.ZVEC_ENABLED !== "false",

  // 环境
  isProduction: process.env.NODE_ENV === "production",
};
