/**
 * 天宫 SSO 验收 —— 未配置 / 降级边界场景（协议 v2）。
 *
 * 运行（不要跑全量套件）：npx vitest run api/sso-router-unconfigured.test.ts
 *
 * 与主测试文件分离的原因：lib/env.ts 在 import 时冻结环境变量快照，
 * 本文件用 vi.resetModules + 动态 import 切换 TIANGONG_JWKS_URL 组合。
 * 全程无 TIANGONG_SSO_SECRET（测纯 v2 配置语义）。
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as jose from "jose";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "admin-password";
  process.env.JWT_SECRET = "unit-test-jwt-secret-0123456789abcdef";
  process.env.SQLITE_PATH = `/tmp/xuanji-sso-test-unconf-${process.pid}/xuanji.db`;
  // 本文件主题：无共享密钥时的配置语义
  delete process.env.TIANGONG_SSO_SECRET;
});

const { privateKey } = generateKeyPairSync("ed25519");

/** 签一张格式合法的 EdDSA 票据（kid 随意——部分用例只考察配置检查/拉取失败路径） */
async function eddsaToken(kid: string): Promise<string> {
  return new jose.SignJWT({ typ: "sso-launch", sub: "1", role: "admin", app: "xuanji" })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuedAt()
    .setExpirationTime("120s")
    .setJti(randomUUID())
    .sign(privateKey);
}

/** 以指定 JWKS URL 组合重新加载 sso-router（env 冻结 → 只能重载模块） */
async function loadRouter(jwksUrl: string) {
  vi.resetModules();
  process.env.TIANGONG_JWKS_URL = jwksUrl;
  const { ssoRouter } = await import("./sso-router");
  const app = new Hono();
  app.route("/sso", ssoRouter);
  return app;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /sso/launch（无共享密钥时的配置语义）", () => {
  it("完全未配置（无 secret 且无 JWKS URL）：501（沿用 v1 未配置语义）", async () => {
    const app = await loadRouter("");

    const res = await app.request(`/sso/launch?token=${encodeURIComponent(await eddsaToken("k"))}`);

    expect(res.status).toBe(501);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("无 secret 但 JWKS URL 已配、拉取失败：401（非 501——有来源只是拿不到）", async () => {
    const app = await loadRouter("https://tiangong.test/api/sso/jwks.json");
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const res = await app.request(`/sso/launch?token=${encodeURIComponent(await eddsaToken("k"))}`);

    expect(res.status).toBe(401);
  });

  it("无 secret 且 JWKS 无任何可用公钥：401", async () => {
    const app = await loadRouter("https://tiangong.test/api/sso/jwks.json");
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), { status: 200 }),
    );

    const res = await app.request(`/sso/launch?token=${encodeURIComponent(await eddsaToken("k"))}`);

    expect(res.status).toBe(401);
  });
});
