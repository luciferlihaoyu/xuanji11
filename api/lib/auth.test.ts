import { describe, expect, it, vi } from "vitest";
import type { AuthInfo } from "./auth";
import { hasScope, scopesFromPermissions, sessionAuth } from "./auth";
import type { User } from "@db/schema";

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
}));

function makeUser(role: "user" | "admin"): User {
  return {
    id: 1,
    unionId: "u-test",
    name: "tester",
    email: null,
    avatar: null,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignInAt: new Date(),
  };
}

describe("sessionAuth（t4：按 role 裁剪 scope）", () => {
  it("admin 会话持有全部管理 scope", () => {
    const auth = sessionAuth(makeUser("admin"));

    expect(auth.type).toBe("session");
    expect(auth.scopes).toContain("knowledge:write");
    expect(auth.scopes).toContain("knowledge:delete");
    expect(auth.scopes).toContain("system:manage");
    expect(auth.scopes).toContain("workflows:execute");
  });

  it("非 admin 会话（本地 viewer / OAuth 普通用户）只拿只读 scope", () => {
    const auth = sessionAuth(makeUser("user"));

    expect(auth.type).toBe("session");
    expect(auth.scopes).toContain("knowledge:read");
    expect(auth.scopes).toContain("documents:read");
    expect(auth.scopes).toContain("workflows:read");
    expect(auth.scopes).toContain("agents:read");
    expect(auth.scopes).toContain("backups:read");
    expect(auth.scopes).toContain("zvec:read");
    // 任何写/删/管理 scope 都不得出现
    expect(auth.scopes).not.toContain("knowledge:write");
    expect(auth.scopes).not.toContain("documents:delete");
    expect(auth.scopes).not.toContain("workflows:execute");
    expect(auth.scopes).not.toContain("backups:write");
    expect(auth.scopes).not.toContain("system:manage");
    expect(auth.scopes).not.toContain("zvec:write");
    expect(hasScope(auth, "knowledge:write")).toBe(false);
  });
});

describe("API key scope helpers", () => {
  it("maps agent permissions to enforced scopes", () => {
    // Given: an agent permission set with read, write, and workflow execution enabled.
    const permissions = { read: true, write: true, executeWorkflow: true, delete: false };

    // When: permissions are converted to API-key scopes.
    const scopes = scopesFromPermissions(permissions);

    // Then: required read/write/execute scopes are present and disabled permissions are absent.
    expect(scopes).toContain("knowledge:read");
    expect(scopes).toContain("documents:write");
    expect(scopes).toContain("backups:write");
    expect(scopes).toContain("workflows:execute");
    expect(scopes).toContain("zvec:read");
    expect(scopes).toContain("zvec:write");
    expect(scopes).not.toContain("knowledge:delete");
  });

  it("rejects missing scopes", () => {
    // Given: an API-key auth context that only has read access.
    const auth: AuthInfo = { type: "apiKey", userId: 1, agentId: 2, scopes: ["knowledge:read"] };

    // When: scope membership is checked.
    const canReadKnowledge = hasScope(auth, "knowledge:read");
    const canWriteKnowledge = hasScope(auth, "knowledge:write");

    // Then: only the held scope is allowed.
    expect(canReadKnowledge).toBe(true);
    expect(canWriteKnowledge).toBe(false);
  });
});
