/**
 * 璇玑智脑结构化日志
 * 封装 console 添加时间戳和日志级别，生产环境可替换为 pino/winston
 */

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

const currentLevel: Level = process.env.NODE_ENV === "production" ? "info" : "debug";

function ts(): string {
  return new Date().toISOString();
}

function log(level: Level, msg: string, extra?: unknown) {
  if (levels[level] < levels[currentLevel]) return;
  const entry = `[${ts()}] [${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) {
    if (level === "error") console.error(entry, extra);
    else if (level === "warn") console.warn(entry, extra);
    else console.log(entry, extra);
  } else {
    if (level === "error") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else console.log(entry);
  }
}

export const logger = {
  debug: (msg: string, extra?: unknown) => log("debug", msg, extra),
  info: (msg: string, extra?: unknown) => log("info", msg, extra),
  warn: (msg: string, extra?: unknown) => log("warn", msg, extra),
  error: (msg: string, extra?: unknown) => log("error", msg, extra),
};
