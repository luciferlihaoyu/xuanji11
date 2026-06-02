import "dotenv/config";

export const env = {
  // 本地管理员认证（替代 Kimi OAuth）
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD ?? "xuanji123456",
  jwtSecret: process.env.JWT_SECRET ?? process.env.APP_SECRET ?? "xuanji-local-auth-secret-change-in-production",

  // Kimi OAuth（可选，留空则禁用）
  appId: process.env.APP_ID ?? "",
  appSecret: process.env.APP_SECRET ?? "",
  kimiAuthUrl: process.env.KIMI_AUTH_URL ?? "https://auth.kimi.com",
  kimiOpenUrl: process.env.KIMI_OPEN_URL ?? "https://open.kimi.com",
  ownerUnionId: process.env.OWNER_UNION_ID ?? "",

  // 数据库
  databaseUrl: process.env.DATABASE_URL ?? "",

  // 环境
  isProduction: process.env.NODE_ENV === "production",
};
