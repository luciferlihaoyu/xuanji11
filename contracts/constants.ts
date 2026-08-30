export const Session = {
  cookieName: "xuanji_session",
  // 本地会话 30 天：SSO 重进只需从天宫点一下，代价极低，缩短会话暴露面
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export const ErrorMessages = {
  unauthenticated: "Authentication required",
  insufficientRole: "Insufficient permissions",
} as const;

export const Paths = {
  login: "/login",
  oauthCallback: "/api/oauth/callback",
} as const;
