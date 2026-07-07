import { describe, expect, it, vi } from "vitest";
import type { AuthInfo } from "./auth";
import { hasScope, scopesFromPermissions } from "./auth";

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
}));

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
