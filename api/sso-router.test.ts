/**
 * 天宫 SSO 联邦认证验收测试（协议 v2：EdDSA 主路径 + HS256 兼容回退）。
 *
 * 运行（不要跑全量套件）：npx vitest run api/sso-router.test.ts
 *
 * 前置：vi.hoisted 在 import 前预置 env（lib/env.ts 缺必填变量会 process.exit）。
 * JWKS 来源用 vi.stubGlobal("fetch") 模拟，不发真实网络请求。
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as jose from "jose";

// ─── 必须在模块 import 之前设置的测试环境 ───
vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "admin-password";
  process.env.JWT_SECRET = "unit-test-jwt-secret-0123456789abcdef";
  process.env.SQLITE_PATH = `/tmp/xuanji-sso-test-${process.pid}/xuanji.db`;
  // 共享密钥已配置：HS256 兼容路径可用；501 不触发
  process.env.TIANGONG_SSO_SECRET = "tiangong-sso-shared-secret-unit-test";
  process.env.TIANGONG_JWKS_URL = "https://tiangong.test/api/sso/jwks.json";
});

import { ssoRouter, _resetSsoJwksCacheForTest } from "./sso-router";

// ─── Ed25519 测试钥匙对（模拟天宫 JWKS）───
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicJwk = (await jose.exportJWK(publicKey)) as Record<string, string>;
const kid = createHash("sha256").update(publicJwk.x!).digest("hex").slice(0, 16);

/** 天宫 v2 形态的 JWKS 条目 */
const tiangongJwk = { kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid, alg: "EdDSA", use: "sig" };
/** 干扰用：另一把不相关的公钥 */
const otherJwk = (() => {
  const { publicKey: otherPub } = generateKeyPairSync("ed25519");
  const jwk = jose.exportJWK(otherPub) as unknown as Record<string, string>;
  // exportJWK 是异步的，这里用占位 x 规避顶层 await 叠加（仅需 kid 不命中）
  return { kty: "OKP", crv: "Ed25519", x: "AAAA_other_key_placeholder", kid: "other000000000000", ...{}, ...jwk };
})();

const app = new Hono();
app.route("/sso", ssoRouter);

const fetchMock = vi.fn();

function mockJwks(keys: unknown[]): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ keys }), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

beforeEach(() => {
  _resetSsoJwksCacheForTest();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 票据签发辅助 ───

async function eddsaToken(claims: Record<string, unknown>, opts?: { exp?: string }): Promise<string> {
  const builder = new jose.SignJWT(claims).setProtectedHeader({
    alg: "EdDSA",
    kid,
  });
  if (!("iat" in claims)) builder.setIssuedAt();
  builder.setExpirationTime(opts?.exp ?? "120s");
  if (!("jti" in claims)) builder.setJti(randomUUID());
  return builder.sign(privateKey);
}

async function hs256Token(claims: Record<string, unknown>): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("120s")
    .setJti(randomUUID())
    .sign(new TextEncoder().encode("tiangong-sso-shared-secret-unit-test"));
}

function launchUrl(token: string): string {
  return `/sso/launch?token=${encodeURIComponent(token)}`;
}

const baseClaims = { typ: "sso-launch", sub: "42", role: "admin", app: "xuanji", username: "bixiao" };

// ─── 用例 ───

describe("GET /sso/launch（协议 v2：EdDSA 主路径）", () => {
  it("EdDSA + JWKS 命中 kid：302 跳转并种下 xuanji_session cookie", async () => {
    mockJwks([tiangongJwk]);
    const token = await eddsaToken(baseClaims);

    const res = await app.request(launchUrl(token));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("xuanji_session=");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("jti 一次性：同一票据重放 → 401", async () => {
    mockJwks([tiangongJwk]);
    const token = await eddsaToken(baseClaims);

    const first = await app.request(launchUrl(token));
    const replay = await app.request(launchUrl(token));

    expect(first.status).toBe(302);
    expect(replay.status).toBe(401);
  });

  it("未知 kid：强制刷新一次 JWKS 后命中 → 302（防轮换窗口误杀）", async () => {
    // 第一次 JWKS 不含该 kid（轮换前的旧集合），刷新后含
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [otherJwk] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [tiangongJwk] }), { status: 200 }));
    const token = await eddsaToken(baseClaims);

    const res = await app.request(launchUrl(token));

    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("未知 kid 且刷新后仍无：401", async () => {
    mockJwks([otherJwk]);
    const token = await eddsaToken(baseClaims);

    const res = await app.request(launchUrl(token));

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("header 无 kid 的 EdDSA 票据：401（不接受盲选密钥）", async () => {
    mockJwks([tiangongJwk]);
    const token = await new jose.SignJWT(baseClaims)
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt()
      .setExpirationTime("120s")
      .setJti(randomUUID())
      .sign(privateKey);

    const res = await app.request(launchUrl(token));

    expect(res.status).toBe(401);
  });

  it("JWKS 拉取失败（网络异常）：401", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const token = await eddsaToken(baseClaims);

    const res = await app.request(launchUrl(token));

    expect(res.status).toBe(401);
  });

  it("JWKS 返回非 2xx：401", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 500 }));
    const token = await eddsaToken(baseClaims);

    const res = await app.request(launchUrl(token));

    expect(res.status).toBe(401);
  });
});

describe("GET /sso/launch（HS256 兼容回退）", () => {
  it("HS256 + 共享密钥：302（部署顺序错位的安全网）", async () => {
    const token = await hs256Token(baseClaims);

    const res = await app.request(launchUrl(token));

    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("xuanji_session=");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HS256 重放：401", async () => {
    const token = await hs256Token(baseClaims);
    await app.request(launchUrl(token));
    const replay = await app.request(launchUrl(token));
    expect(replay.status).toBe(401);
  });

  it("未知算法：401", async () => {
    const token = await new jose.SignJWT(baseClaims)
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setExpirationTime("120s")
      .setJti(randomUUID())
      .sign(new TextEncoder().encode("tiangong-sso-shared-secret-unit-test"));

    const res = await app.request(launchUrl(token));

    expect(res.status).toBe(401);
  });
});

describe("GET /sso/launch（声明与协议校验，v2 沿用 v1 语义）", () => {
  it("typ 不符：401", async () => {
    mockJwks([tiangongJwk]);
    const token = await eddsaToken({ ...baseClaims, typ: "other" });
    const res = await app.request(launchUrl(token));
    expect(res.status).toBe(401);
  });

  it("app 不符：401", async () => {
    mockJwks([tiangongJwk]);
    const token = await eddsaToken({ ...baseClaims, app: "beidou" });
    const res = await app.request(launchUrl(token));
    expect(res.status).toBe(401);
  });

  it("sub / role 缺失：401", async () => {
    mockJwks([tiangongJwk]);
    const noSub = await eddsaToken({ typ: "sso-launch", role: "admin", app: "xuanji" });
    const noRole = await eddsaToken({ typ: "sso-launch", sub: "1", app: "xuanji" });
    expect((await app.request(launchUrl(noSub))).status).toBe(401);
    expect((await app.request(launchUrl(noRole))).status).toBe(401);
  });

  it("exp 已过期：401", async () => {
    mockJwks([tiangongJwk]);
    const token = await eddsaToken(baseClaims, { exp: "-120s" });
    const res = await app.request(launchUrl(token));
    expect(res.status).toBe(401);
  });

  it("token 缺失：401", async () => {
    const res = await app.request("/sso/launch");
    expect(res.status).toBe(401);
  });

  it("token 乱码：401（不可解析的 header）", async () => {
    const res = await app.request(launchUrl("not-a-jwt"));
    expect(res.status).toBe(401);
  });
});
