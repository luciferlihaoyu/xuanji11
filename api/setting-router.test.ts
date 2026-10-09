/**
 * setting-router 的 MASK 语义与审计脱敏（t2 补测）。
 *
 * 为什么需要这个文件：t2 的核心写侧承诺是"读侧出参掩码后，前端把掩码原样回传时
 * 绝不能让 `***masked***` 落库把真秘密覆盖掉"，而 setting-router.set/setMany 正是
 * systemSettings 的唯一写入口（admin_password_hash、alist_token 等都在此表）。
 * 独立复核指出：该分支此前只有代码证据、没有自动化证据 —— 本文件补上。
 *
 * 跑在真实内存 SQLite 上（仓库既有范式：datasource-router.test.ts 的真库 harness），
 * 表按 @db/schema 的 systemSettings 手写 DDL —— 只有真库才能钉住"库中原值保留"。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@db/schema";
import * as fullSchema from "@db/schema";
import type { TrpcContext } from "./context";
import { getDb } from "./queries/connection";
import { sessionAuth } from "./lib/auth";
import { logAudit } from "./lib/audit";
import { MASK } from "./lib/setting-mask";
import { settingRouter } from "./setting-router";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));

// 审计落库不参与断言（直接看 logAudit 的入参），mock 掉避免真库副作用。
vi.mock("./lib/audit", () => ({ logAudit: vi.fn(), logAction: vi.fn() }));

// vector-service 传递引入 Zvec 原生二进制，本容器无 ld-linux 会崩；本文件只走
// set/setMany，不触碰向量模板端点，整体 mock 即可。
vi.mock("./lib/vector-service", () => ({
  vectorEngine: { size: 0 },
  initializeZvec: vi.fn(),
  listVectorModelTemplates: vi.fn(),
  getVectorModelTemplate: vi.fn(),
  saveVectorModelTemplate: vi.fn(),
  deleteVectorModelTemplate: vi.fn(),
  selectVectorModelTemplate: vi.fn(),
  testVectorModelTemplate: vi.fn(),
}));

const DDL = `
  CREATE TABLE system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    category TEXT DEFAULT 'general',
    updatedBy INTEGER,
    updatedAt INTEGER NOT NULL DEFAULT 0
  );
`;

type SeedRow = { key: string; value: string | null; category?: string };

function fakeUser(): User {
  return {
    id: 1,
    unionId: "local_admin",
    name: "admin",
    email: null,
    avatar: null,
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignInAt: new Date(),
  };
}

function makeContext(): TrpcContext {
  const user = fakeUser();
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    auth: sessionAuth(user),
  };
}

function createHarness(seed: readonly SeedRow[] = []) {
  const raw = new Database(":memory:");
  raw.exec(DDL);
  const insert = raw.prepare(
    `INSERT INTO system_settings (key, value, category, updatedAt) VALUES (?, ?, ?, 0)`,
  );
  for (const row of seed) insert.run(row.key, row.value, row.category ?? "general");

  vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);

  return {
    caller: settingRouter.createCaller(makeContext()),
    /** 直读真库，确认"没写库"与"原值保留"是事实而非推断。 */
    readValue: (key: string): string | null | undefined =>
      (raw.prepare(`SELECT value FROM system_settings WHERE key = ?`).get(key) as
        | { value: string | null }
        | undefined)?.value,
    rowCount: (): number =>
      (raw.prepare(`SELECT COUNT(*) AS n FROM system_settings`).get() as { n: number }).n,
    /** logAudit(ctx, category, action, targetId, details) 的 details 序列化。 */
    auditDetails: (): string =>
      vi.mocked(logAudit)
        .mock.calls.map((call) => JSON.stringify(call[4] ?? null))
        .join("\n"),
  };
}

describe("settingRouter MASK semantics (t2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the stored secret when the masked placeholder is submitted", async () => {
    const h = createHarness([{ key: "admin_password_hash", value: "real-bcrypt-hash" }]);

    const result = await h.caller.set({ key: "admin_password_hash", value: MASK });

    // 回执标 unchanged，库中真值原样保留（掩码绝不落库）
    expect(result).toMatchObject({ success: true, unchanged: true });
    expect(h.readValue("admin_password_hash")).toBe("real-bcrypt-hash");
    // 占位路径的审计只落 { key, unchanged }，真值不出现
    expect(h.auditDetails()).not.toContain("real-bcrypt-hash");
    expect(h.auditDetails()).toContain("admin_password_hash");
  });

  it("does not treat the placeholder as a secret for a non-secret key", async () => {
    const h = createHarness([{ key: "some_label", value: "old-label" }]);

    const result = await h.caller.set({ key: "some_label", value: MASK });

    // 非敏感键：MASK 只是普通字符串，照常写入（否则会静默吞掉用户输入）
    expect(result).toMatchObject({ success: true });
    expect(h.readValue("some_label")).toBe(MASK);
  });

  it("writes a new plaintext secret yet never echoes it into the audit log", async () => {
    const h = createHarness([{ key: "admin_password_hash", value: "old-hash" }]);

    await h.caller.set({ key: "admin_password_hash", value: "new-plain-hash" });

    expect(h.readValue("admin_password_hash")).toBe("new-plain-hash");
    // 审计第二落点（原 setting:103）：敏感值必须被 redact
    expect(h.auditDetails()).not.toContain("new-plain-hash");
    expect(h.auditDetails()).toContain(MASK);
  });

  it("keeps non-secret values traceable in the audit log", async () => {
    const h = createHarness([{ key: "site_title", value: "旧标题" }]);

    await h.caller.set({ key: "site_title", value: "璇玑知识库" });

    expect(h.readValue("site_title")).toBe("璇玑知识库");
    // 非敏感值保留（redact 只对敏感键生效），变更历史仍可追溯
    expect(h.auditDetails()).toContain("璇玑知识库");
  });

  it("inserts a brand new key", async () => {
    const h = createHarness();

    await h.caller.set({ key: "profile_theme", value: "dark" });

    expect(h.readValue("profile_theme")).toBe("dark");
    expect(h.rowCount()).toBe(1);
  });

  it("applies the mask semantics per item in setMany", async () => {
    const h = createHarness([
      { key: "admin_password_hash", value: "real-hash" },
      { key: "alist_token", value: "real-token" },
      { key: "site_title", value: "old-title" },
    ]);

    await h.caller.setMany([
      { key: "admin_password_hash", value: MASK }, // 占位 → 保留原值
      { key: "alist_token", value: "brand-new-token" }, // 新明文 → 覆盖
      { key: "site_title", value: "new-title" }, // 非敏感 → 覆盖
      { key: "fresh_key", value: "fresh" }, // 新键 → 插入
    ]);

    expect(h.readValue("admin_password_hash")).toBe("real-hash");
    expect(h.readValue("alist_token")).toBe("brand-new-token");
    expect(h.readValue("site_title")).toBe("new-title");
    expect(h.readValue("fresh_key")).toBe("fresh");

    // 整批审计：占位键列在 unchangedKeys，两个明文秘密都不出现
    const audit = h.auditDetails();
    expect(audit).toContain("admin_password_hash");
    expect(audit).not.toContain("real-hash");
    expect(audit).not.toContain("brand-new-token");
  });
});
