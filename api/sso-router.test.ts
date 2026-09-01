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

import { ssoRouter, _resetSsoJwksCacheForTest, _ageLastJwksFetchForTest } from "./sso-router";

// ─── Ed25519 测试钥匙对（模拟天宫 JWKS）───
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicJwk = (await jose.exportJWK(publicKey)) as Record<string, string>;
const kid = createHash("sha256").update(publicJwk.x!).digest("hex").slice(0, 16);

/** 天宫 v2 形态的 JWKS 条目 */
const tiangongJwk = { kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid, alg: "EdDSA", use: "sig" };
/** 干扰用：另一把不相关的密钥对（真实公钥 + 固定 kid，可用其私钥签"未知 kid"票据） */
const otherKeyPair = generateKeyPairSync("ed25519");
const otherPublicJwk = (await jose.exportJWK(otherKeyPair.publicKey)) as Record<string, string>;
const otherJwk = { kty: "OKP", crv: "Ed25519", x: otherPublicJwk.x!, kid: "other000000000000", alg: "EdDSA", use: "sig" };

/** 轮换后的新密钥对（模拟天宫换钥：旧缓存不含其 kid，强刷后才出现） */
const rotatedKeyPair = generateKeyPairSync("ed25519");
const rotatedPublicJwk = (await jose.exportJWK(rotatedKeyPair.publicKey)) as Record<string, string>;
const rotatedKid = createHash("sha256").update(rotatedPublicJwk.x!).digest("hex").slice(0, 16);
const rotatedJwk = { kty: "OKP", crv: "Ed25519", x: rotatedPublicJwk.x!, kid: rotatedKid, alg: "EdDSA", use: "sig" };

const app = new Hono();
app.route("/sso", ssoRouter);

const fetchMock = vi.fn();

function jwksResponse(keys: unknown[]): Response {
  return new Response(JSON.stringify({ keys }), { status: 200, headers: { "content-type": "application/json" } });
}

function mockJwks(keys: unknown[]): void {
  fetchMock.mockResolvedValue(jwksResponse(keys));
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

async function eddsaToken(
  claims: Record<string, unknown>,
  opts?: { exp?: string; kid?: string; signKey?: Parameters<typeof jose.SignJWT.prototype.sign>[0] },
): Promise<string> {
  const builder = new jose.SignJWT(claims).setProtectedHeader({
    alg: "EdDSA",
    kid: opts?.kid ?? kid,
  });
  if (!("iat" in claims)) builder.setIssuedAt();
  builder.setExpirationTime(opts?.exp ?? "120s");
  if (!("jti" in claims)) builder.setJti(randomUUID());
  return builder.sign(opts?.signKey ?? privateKey);
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

  it("未知 kid：节流窗外强制刷新一次后命中 → 302（防轮换窗口误杀）", async () => {
    // 第一步：轮换前票据完成一次成功拉取（建立缓存与节流时间戳）
    fetchMock.mockResolvedValueOnce(jwksResponse([tiangongJwk]));
    const warmup = await app.request(launchUrl(await eddsaToken(baseClaims)));
    expect(warmup.status).toBe(302);
    // 模拟距上次成功拉取已超过 30s 强刷节流窗口
    _ageLastJwksFetchForTest(31_000);
    // 第二步：轮换后新票据（缓存 TTL 内命中不出站；强刷一次拿到新公钥）→ 命中
    fetchMock.mockResolvedValueOnce(jwksResponse([tiangongJwk, rotatedJwk]));
    const res = await app.request(
      launchUrl(await eddsaToken(baseClaims, { kid: rotatedKid, signKey: rotatedKeyPair.privateKey })),
    );
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("未知 kid：节流窗外强刷一次仍无 → 401（fetch 共 2 次）", async () => {
    // JWKS 永远只含天宫已知公钥；票据用另一把私钥签（kid 不在任何响应里）
    mockJwks([tiangongJwk]);
    const tokenOpts = { kid: otherJwk.kid, signKey: otherKeyPair.privateKey };
    // 第一次：冷缓存拉取 1 次；强刷被节流（刚拉取成功，窗口内）→ 401
    const first = await app.request(launchUrl(await eddsaToken(baseClaims, tokenOpts)));
    expect(first.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 节流窗外再来一次：缓存命中不出站 → 强刷 1 次 → 仍无 → 401
    _ageLastJwksFetchForTest(31_000);
    const second = await app.request(launchUrl(await eddsaToken(baseClaims, tokenOpts)));
    expect(second.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("强刷节流：30s 窗口内第二次未知 kid 不再出站（fetch 计数不 +1）", async () => {
    mockJwks([tiangongJwk]);
    const tokenOpts = { kid: otherJwk.kid, signKey: otherKeyPair.privateKey };
    await app.request(launchUrl(await eddsaToken(baseClaims, tokenOpts)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const res = await app.request(launchUrl(await eddsaToken(baseClaims, tokenOpts)));
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("并发单飞：3 个未知 kid 请求并发到达只发 1 次 fetch", async () => {
    mockJwks([tiangongJwk]);
    const token = await eddsaToken(baseClaims, { kid: otherJwk.kid, signKey: otherKeyPair.privateKey });
    const results = await Promise.all([
      app.request(launchUrl(token)),
      app.request(launchUrl(token)),
      app.request(launchUrl(token)),
    ]);
    // 全部 401（kid 未命中 + 强刷被节流）；出站拉取合并为一次
    for (const res of results) expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("JWKS 响应体超限（content-length > 64KB）：401（m-5 大小守卫）", async () => {
    // 显式声明超限 content-length（守卫在解析前拦截）
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ keys: [tiangongJwk] }), {
        status: 200,
        headers: { "content-length": String(70 * 1024) },
      }),
    );
    const res = await app.request(launchUrl(await eddsaToken(baseClaims)));
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("60s 时钟容差：容差窗内的过期票据（-30s）可验签成功，且 jti 保留到窗末（重放 401）", async () => {
    mockJwks([tiangongJwk]);
    const token = await eddsaToken(baseClaims, { exp: "-30s" });

    const first = await app.request(launchUrl(token));
    expect(first.status).toBe(302);
    expect(first.headers.get("set-cookie")).toContain("xuanji_session=");

    // 窗末之前重放：jti 账本保留到 exp + 60s 容差窗结束 → 401
    const replay = await app.request(launchUrl(token));
    expect(replay.status).toBe(401);
  });

  it("60s 时钟容差：超过容差窗的过期票据（-90s）→ 401", async () => {
    mockJwks([tiangongJwk]);
    const token = await eddsaToken(baseClaims, { exp: "-90s" });
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
