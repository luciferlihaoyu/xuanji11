import { describe, it, expect } from "vitest";
import {
  maskSettingValue,
  isSensitiveSettingKey,
  maskConnectorConfig,
  isSecretKey,
  stripMaskedSecrets,
  redactAuditInput,
  MASK,
} from "./setting-mask";

describe("isSensitiveSettingKey", () => {
  it.each([
    ["admin_password_hash", true],
    ["admin_password_changed_at", true],
    ["alist_password", true],
    ["connector_alist_config", false],
    ["embedding_api_key", true],
    ["tianshu_api_key", true],
    ["agent_token", true],
    ["jwt_secret", true],
    ["oauth_client_secret", true],
    ["storage_documents_size", false],
    ["profile_nickname", false],
    ["theme", false],
  ])("%s → %j", (key, expected) => {
    expect(isSensitiveSettingKey(key)).toBe(expected);
  });
});

describe("maskSettingValue", () => {
  it("敏感键返回掩码", () => {
    expect(maskSettingValue("admin_password_hash", "bcrypt$abc")).toBe("***masked***");
    expect(maskSettingValue("tianshu_api_key", "sk-123")).toBe("***masked***");
  });

  it("非敏感键原样返回", () => {
    expect(maskSettingValue("storage_documents_size", "1024")).toBe("1024");
    expect(maskSettingValue("profile_nickname", "碧霄")).toBe("碧霄");
  });

  it("空值不产生信息泄漏差异", () => {
    expect(maskSettingValue("agent_token", "")).toBe("***masked***");
  });
});

describe("maskConnectorConfig", () => {
  it("password/secret/token/apiKey 字段被掩码，其余保留", () => {
    const cfg = {
      url: "https://alist.example.com",
      username: "admin",
      password: "plain-pass",
      apiKey: "sk-xyz",
      nested: { refreshToken: "r-1", keep: 1 },
    };
    const out = maskConnectorConfig(cfg) as Record<string, unknown>;
    expect(out.url).toBe("https://alist.example.com");
    expect(out.username).toBe("admin");
    expect(out.password).toBe("***masked***");
    expect(out.apiKey).toBe("***masked***");
    expect((out.nested as Record<string, unknown>).refreshToken).toBe("***masked***");
    expect((out.nested as Record<string, unknown>).keep).toBe(1);
  });

  it("null/非对象安全返回", () => {
    expect(maskConnectorConfig(null)).toBeNull();
    expect(maskConnectorConfig("str" as unknown as Record<string, unknown>)).toBe("str");
  });
});

// ═══ t2（M1 写侧 + 审计第二落点）：stripMaskedSecrets / redactAuditInput / isSecretKey ═══

describe("isSecretKey (t2)", () => {
  it("与 isSensitiveSettingKey 同一判定口径", () => {
    for (const key of ["admin_password_hash", "apiKey", "refreshToken", "agent_token", "jwt_secret"]) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ["url", "platform", "syncInterval", "theme", "connector_alist_config"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe("stripMaskedSecrets (t2 写侧剥掩码占位)", () => {
  it("敏感键的掩码值被剥除，changedKeys 记录路径", () => {
    const { value, changedKeys } = stripMaskedSecrets({ apiKey: MASK, url: "x" });
    expect(value).toEqual({ url: "x" });
    expect(changedKeys).toEqual(["apiKey"]);
  });

  it("非敏感键的掩码字面量不是占位——原样保留", () => {
    // 用户真想把某条备注写成 "***masked***" 不该被吞掉；占位判定必须绑定敏感键。
    const { value, changedKeys } = stripMaskedSecrets({ note: MASK, url: "x" });
    expect(value).toEqual({ note: MASK, url: "x" });
    expect(changedKeys).toEqual([]);
  });

  it("敏感键的新明文（用户重填）照常保留", () => {
    const { value, changedKeys } = stripMaskedSecrets({ apiKey: "sk-new", url: "x" });
    expect(value).toEqual({ apiKey: "sk-new", url: "x" });
    expect(changedKeys).toEqual([]);
  });

  it("嵌套对象递归剥除，changedKeys 用点分路径", () => {
    const { value, changedKeys } = stripMaskedSecrets({
      url: "x",
      nested: { refreshToken: MASK, keep: 1 },
    });
    expect(value).toEqual({ url: "x", nested: { keep: 1 } });
    expect(changedKeys).toEqual(["nested.refreshToken"]);
  });

  it("数组逐项递归", () => {
    const { value, changedKeys } = stripMaskedSecrets([{ apiKey: MASK }, { url: "y" }]);
    expect(value).toEqual([{}, { url: "y" }]);
    expect(changedKeys).toEqual(["[0].apiKey"]);
  });

  it("空字符串的敏感键不剥（清空语义交给调用方）", () => {
    const { value, changedKeys } = stripMaskedSecrets({ apiKey: "", url: "x" });
    expect(value).toEqual({ apiKey: "", url: "x" });
    expect(changedKeys).toEqual([]);
  });

  it("非对象输入（含 undefined/null）原样返回 value", () => {
    expect(stripMaskedSecrets(undefined)).toEqual({ value: undefined, changedKeys: [] });
    expect(stripMaskedSecrets(null)).toEqual({ value: null, changedKeys: [] });
    expect(stripMaskedSecrets("str").value).toBe("str");
  });

  it("纯函数：不修改调用方传入的原对象", () => {
    const input = { apiKey: MASK, nested: { refreshToken: MASK } };
    stripMaskedSecrets(input);
    expect(input).toEqual({ apiKey: MASK, nested: { refreshToken: MASK } });
  });
});

describe("redactAuditInput (t2 审计脱敏)", () => {
  it("setting 审计行形态：{key: 敏感键名, value} 的 value 一律掩码", () => {
    // "value" 这个键名本身不匹配敏感模式——没有对偶规则，新密码就原样进审计了。
    expect(redactAuditInput({ key: "admin_password_hash", value: "real" })).toEqual({
      key: "admin_password_hash",
      value: MASK,
    });
  });

  it("{key: 非敏感键名, value} 原样保留（审计可见配置变更）", () => {
    expect(redactAuditInput({ key: "theme", value: "dark" })).toEqual({ key: "theme", value: "dark" });
  });

  it("敏感键的字符串值被掩码，其余原样；保留全部键", () => {
    const out = redactAuditInput({ apiKey: "sk-123", url: "https://x", nested: { refreshToken: "r-1", n: 1 } }) as Record<string, unknown>;
    expect(out.apiKey).toBe(MASK);
    expect(out.url).toBe("https://x");
    expect((out.nested as Record<string, unknown>).refreshToken).toBe(MASK);
    expect((out.nested as Record<string, unknown>).n).toBe(1);
    expect(Object.keys(out).sort()).toEqual(["apiKey", "nested", "url"]);
  });

  it("数组递归：setMany 的 { items: [...] } 形态逐项脱敏", () => {
    const out = redactAuditInput({
      items: [
        { key: "jwt_secret", value: "s3cret", category: "general" },
        { key: "theme", value: "dark", category: "general" },
      ],
    }) as { items: Array<{ key: string; value: string }> };
    expect(out.items[0].value).toBe(MASK);
    expect(out.items[1].value).toBe("dark");
  });

  it("空字符串保持空串（无信息量，不制造存有秘密的假象）", () => {
    expect(redactAuditInput({ apiKey: "" })).toEqual({ apiKey: "" });
  });

  it("非对象安全返回", () => {
    expect(redactAuditInput(null)).toBeNull();
    expect(redactAuditInput("plain")).toBe("plain");
  });
});
