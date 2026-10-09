/**
 * t6/M2：getWebhookUrl 现在 async，内部查 DB 拿 updatedAt 让 token 绑定工作流版本。
 * 改工作流 → token 变 → 旧 token 失效。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebhookUrl } from "./workflow-scheduler";
import { getDb } from "../queries/connection";

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
}));

const SECRET = "test-jwt-secret-at-least-32-chars-long!!";
const UPDATED_AT_MS = 1_700_000_000_000;

vi.hoisted(() => {
  // env 必须在 import env 模块之前就位（vi.hoisted 跑在 module import 之前）
  process.env.JWT_SECRET = "test-jwt-secret-at-least-32-chars-long!!";
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-chars-long!!!";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
});
function fakeDbReturning(rows: Array<{ updatedAt: Date } | { updatedAt: null }>): unknown {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  };
}

describe("getWebhookUrl (t6/M2)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("DB 查到的 updatedAt 拼入 token；改工作流（updatedAt 变）即换 token", async () => {
    // 同一 workflow，两次不同 updatedAt
    const t1 = await getWebhookUrlForUpdatedAt(new Date(UPDATED_AT_MS));
    const t2 = await getWebhookUrlForUpdatedAt(new Date(UPDATED_AT_MS + 5_000));

    // URL 形如 https://host/api/workflows/1/webhook?token=<32hex>
    expect(t1).toMatch(/^https:\/\/host\.test\/api\/workflows\/1\/webhook\?token=[0-9a-f]{32}$/);
    expect(t2).toMatch(/^https:\/\/host\.test\/api\/workflows\/1\/webhook\?token=[0-9a-f]{32}$/);
    // 改工作流后 token 必变（M2 修复目标）
    expect(t1).not.toBe(t2);
  });

  it("workflow 不存在时退化到 updatedAt=0（生成 token 仍可产生但 verify 时失败）", async () => {
    vi.mocked(getDb).mockReturnValue(fakeDbReturning([{ updatedAt: null }]) as never);

    // 不抛错即可——调用方应当先确认 workflow 存在
    const url = await getWebhookUrl(1, "https://host.test");
    expect(url).toMatch(/\?token=[0-9a-f]{32}$/);
  });

  it("baseUrl 尾斜杠被剥离", async () => {
    vi.mocked(getDb).mockReturnValue(fakeDbReturning([{ updatedAt: new Date(UPDATED_AT_MS) }]) as never);
    const url = await getWebhookUrl(1, "https://host.test/");
    expect(url).toMatch(/^https:\/\/host\.test\/api\//);
    expect(url).not.toMatch(/\/\/api\//);
  });

  it("URL 形态稳定：含 path /api/workflows/<id>/webhook 与 ?token= query", async () => {
    vi.mocked(getDb).mockReturnValue(fakeDbReturning([{ updatedAt: new Date(UPDATED_AT_MS) }]) as never);
    const url = await getWebhookUrl(42, "https://api.example.com");
    expect(url).toContain("/api/workflows/42/webhook?token=");
  });
});

async function getWebhookUrlForUpdatedAt(updatedAt: Date): Promise<string> {
  vi.mocked(getDb).mockReturnValue(fakeDbReturning([{ updatedAt }]) as never);
  return getWebhookUrl(1, "https://host.test");
}
