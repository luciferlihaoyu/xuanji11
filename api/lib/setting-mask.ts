/**
 * 敏感设置键/连接器配置的脱敏工具。
 *
 * 背景：system_settings 表中存有 admin_password_hash、连接器明文密码、
 * 嵌入模板 apiKey 等秘密值。任何返回给客户端的设置读取路径都必须先过
 * 这里的掩码规则，避免秘密值经 tRPC 泄漏给非管理员会话。
 */

const SENSITIVE_KEY_PATTERN = /password|secret|token|api_key|apikey|credential/i;

const MASK = "***masked***";

export function isSensitiveSettingKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function maskSettingValue(key: string, value: string): string {
  return isSensitiveSettingKey(key) ? MASK : value;
}

/** 对 systemSettings 行数组统一掩码（保留行结构，仅替换 value）。 */
export function maskSettingRows<T extends { key: string; value: string | null }>(
  rows: T[],
): T[] {
  return rows.map((row) => ({
    ...row,
    value: row.value === null ? row.value : maskSettingValue(row.key, row.value),
  }));
}

/**
 * 递归掩码连接器 config 中的秘密字段（password/secret/token/apiKey/credential 等，
 * 键名匹配不区分大小写），非敏感字段原样保留。非对象输入原样返回。
 */
export function maskConnectorConfig<T>(config: T): T {
  if (config === null || typeof config !== "object") return config;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string" && SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = v === "" ? "" : MASK;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  };

  return walk(config) as T;
}
