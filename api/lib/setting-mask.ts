/**
 * 敏感设置键/连接器配置的脱敏工具。
 *
 * 背景：system_settings 表中存有 admin_password_hash、连接器明文密码、
 * 嵌入模板 apiKey 等秘密值。任何返回给客户端的设置读取路径都必须先过
 * 这里的掩码规则，避免秘密值经 tRPC 泄漏给非管理员会话。
 */

const SENSITIVE_KEY_PATTERN = /password|secret|token|api_key|apikey|credential/i;

/** 掩码字面量。t2 起导出：读侧出参掩码与写侧"占位识别"必须共用同一个哨兵值，
 *  各自硬编码一旦漂移，写侧 strip 就会漏剥、把掩码当真实凭据落库。 */
export const MASK = "***masked***";

export function isSensitiveSettingKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** t2（H1/M1）：同一套敏感键判定，供写侧 strip / 审计 redact 使用（语义命名更直白）。 */
export function isSecretKey(k: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(k);
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

/**
 * t2（M1 写侧）：剥除"掩码占位"字段。
 *
 * 读侧出参统一掩码后，前端把掩码值原样回传是常态（编辑表单未改动该秘密时）；
 * 若不剥除，"***masked***" 会作为真实凭据落库，静默毁掉该数据源的连接。
 * 只剥「敏感键 && 值恰为 MASK」的字段——敏感键的新明文（用户重填）照常保留。
 * changedKeys 记录剥除的键路径（嵌套用点分），供审计日志结构性可见。
 * 非对象输入（含 undefined）原样返回 value，让调用方的 clean() 决定是否落该列。
 */
export function stripMaskedSecrets<T>(input: T): { value: T; changedKeys: string[] } {
  const changedKeys: string[] = [];
  const walk = (node: unknown, prefix: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${prefix}[${i}]`));
    }
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string" && v === MASK && isSecretKey(k)) {
        changedKeys.push(path);
        continue; // 剥除 = 输出中不含该键（由调用方与库中旧值合并，绝不把掩码写回去）
      }
      out[k] = walk(v, path);
    }
    return out;
  };
  return { value: walk(input, "") as T, changedKeys };
}

/**
 * t2（审计第二落点）：审计输入整体脱敏。
 *
 * 递归掩码敏感键的字符串值，并识别 { key, value } 键值对形态（setting set 的
 * input 正是这个形状）：key 本身命中敏感规则时，value 一律掩码——否则
 * "value" 这个键名不匹配敏感模式，admin_password_hash 的新值就会原样进审计。
 * 与 maskConnectorConfig 的分工：这里面向审计详情（保留全部键、结构性可见），
 * 空字符串保持空串（无信息量，不制造"存有秘密"的假象）。
 */
export function redactAuditInput<T>(input: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    // { key: <敏感键名>, value: <非空 string> } 对偶：setting 审计行的形状。
    const pairValueMasked =
      typeof record.key === "string" &&
      isSecretKey(record.key) &&
      typeof record.value === "string" &&
      record.value !== "";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (pairValueMasked && k === "value") {
        out[k] = MASK;
      } else if (typeof v === "string" && isSecretKey(k) && v !== "") {
        out[k] = MASK;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  };
  return walk(input) as T;
}
