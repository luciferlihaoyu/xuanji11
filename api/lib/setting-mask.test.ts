import { describe, it, expect } from "vitest";
import { maskSettingValue, isSensitiveSettingKey, maskConnectorConfig } from "./setting-mask";

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
