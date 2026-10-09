/**
 * Kimi OAuth callback 集成测试（t4/P7 补测）。
 *
 * 覆盖的修复点（报告 H4）：
 * ① state 必须由本服务签发且一次性消费 —— 旧实现直接 `atob(state)` 当 redirectUri 用，
 *    等于让攻击者指定任意回调地址（login CSRF / 授权码窃取）；
 * ② access token 的 client_id 必须等于本应用 APP_ID —— 否则他应用签发的 token 可登录；
 * ③ redirectUri 取固定可信来源（env > X-Forwarded-* > 请求 URL），与 state 解耦。
 *
 * 集成的真实性：**不 mock api/lib/oauth-state** —— state 的签发/消费用的是真实实现，
 * 所以本文件真的在验证"接线是否正确"，而不只是各单元自己自洽。
 * jose 的远程 JWKS 与 token exchange 通过 mock global.fetch 提供，
 * access token 由本测试用真密钥对现签（RS256），jose 会真实验签。
 */
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, KeyObject } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Paths, Session } from "@contracts/constants";
import { __resetForTests as resetOAuthState } from "../lib/oauth-state";
import { env } from "../lib/env";

vi.hoisted(() => {
  // env 模块在加载时校验必填项并 process.exit，须在 importActual 之前就绪。
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
  process.env.DATABASE_URL = "file::memory:";
});

vi.mock("../lib/env", async () => {
  const actual = await vi.importActual<typeof import("../lib/env")>("../lib/env");
  return {
    ...actual,
    env: {
      ...actual.env,
      appId: "test-app-id",
      appSecret: "test-app-secret",
      kimiAuthUrl: "https://auth.kimi.test",
      kimiRedirectUri: "",
    },
  };
});

vi.mock("./session", () => ({
  signSessionToken: vi.fn(async () => "signed-session-token"),
  verifySessionToken: vi.fn(async () => null),
}));

vi.mock("./platform", () => ({
  users: { getProfile: vi.fn() },
}));

vi.mock("../queries/users", () => ({
  findUserByUnionId: vi.fn(async () => null),
  upsertUser: vi.fn(async () => undefined),
}));

import { users as kimiUsers } from "./platform";
import { upsertUser } from "../queries/users";
import { createOAuthCallbackHandler, verifyAccessToken } from "./auth";
import { issueOAuthState } from "../lib/oauth-state";

const CALLBACK = Paths.oauthCallback;
const KIMI_USER_ID = "kimi-user-1";

type KeyPair = { publicKey: CryptoKey | KeyObject; privateKey: CryptoKey | KeyObject };

let keys: KeyPair;
let accessToken: string;

/** 用测试密钥对现签 access token（client_id 可指定，用于验证断言生效）。 */
async function signAccessToken(clientId: string): Promise<string> {
  return new SignJWT({ user_id: KIMI_USER_ID, client_id: clientId })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

function makeApp() {
  const app = new Hono();
  app.get(CALLBACK, createOAuthCallbackHandler());
  return app;
}

/** 取最后一次 token exchange 请求体（用于断言 redirect_uri）。 */
function lastTokenExchangeBody(): URLSearchParams | null {
  const calls = vi.mocked(global.fetch).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const input = calls[i]?.[0];
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/oauth/token")) {
      const init = calls[i]?.[1] as RequestInit | undefined;
      return new URLSearchParams(String(init?.body ?? ""));
    }
  }
  return null;
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";

  global.fetch = vi.fn(async (input: string | URL | { url: string }) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/oauth/token")) {
      return new Response(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
});

beforeEach(async () => {
  resetOAuthState();
  vi.clearAllMocks();
  (env as { kimiRedirectUri: string }).kimiRedirectUri = "";
  accessToken = await signAccessToken(env.appId);
  vi.mocked(kimiUsers.getProfile).mockResolvedValue({
    user_id: KIMI_USER_ID,
    name: "Kimi User",
    avatar_url: "https://cdn.test/a.png",
  });
});

describe("Kimi OAuth callback (t4)", () => {
  it("rejects a callback without code or state", async () => {
    const res = await makeApp().request(`http://localhost${CALLBACK}?code=abc`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "code and state are required" });
  });

  it("rejects a forged state (never issued by this service)", async () => {
    const res = await makeApp().request(`http://localhost${CALLBACK}?code=abc&state=forged-state`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid state" });
    // 未通过 state 门槛时不应发起任何出网请求（token exchange 未被触达）
    expect(lastTokenExchangeBody()).toBeNull();
  });

  it("rejects replaying an already consumed state", async () => {
    const state = issueOAuthState();
    const app = makeApp();

    const first = await app.request(`http://localhost${CALLBACK}?code=abc&state=${state}`);
    expect(first.status).toBe(302);

    const second = await app.request(`http://localhost${CALLBACK}?code=abc&state=${state}`);
    expect(second.status).toBe(400);
    await expect(second.json()).resolves.toMatchObject({ error: "invalid state" });
  });

  it("redirects home when the user denies the authorization", async () => {
    const res = await makeApp().request(`http://localhost${CALLBACK}?error=access_denied`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("surfaces other provider errors as 400", async () => {
    const res = await makeApp().request(
      `http://localhost${CALLBACK}?error=invalid_scope&error_description=bad%20scope`,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_scope", error_description: "bad scope" });
  });

  it("completes the flow: sets a session cookie and upserts the user", async () => {
    const state = issueOAuthState();
    const res = await makeApp().request(`http://localhost${CALLBACK}?code=abc&state=${state}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain(Session.cookieName);
    expect(vi.mocked(upsertUser)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertUser).mock.calls[0]?.[0]).toMatchObject({ unionId: KIMI_USER_ID });
  });

  it("rejects an access token issued to another client (client_id mismatch)", async () => {
    accessToken = await signAccessToken("someone-elses-app");
    const state = issueOAuthState();

    const res = await makeApp().request(`http://localhost${CALLBACK}?code=abc&state=${state}`);

    expect(res.status).toBe(500);
    // client_id 断言在验签之后、profile 之前生效：不得建立任何本地身份
    expect(vi.mocked(upsertUser)).not.toHaveBeenCalled();
  });

  it("verifyAccessToken rejects a token minted for another client_id", async () => {
    await expect(verifyAccessToken(await signAccessToken("other-app"))).rejects.toThrow(/client_id mismatch/);
    await expect(verifyAccessToken(await signAccessToken(env.appId))).resolves.toMatchObject({ userId: KIMI_USER_ID });
  });

  describe("resolveRedirectUri (三级回退)", () => {
    it("prefers the explicit env value", async () => {
      (env as { kimiRedirectUri: string }).kimiRedirectUri = "https://configured.example.com/api/oauth/callback";
      const state = issueOAuthState();

      await makeApp().request(`http://localhost${CALLBACK}?code=abc&state=${state}`, {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "proxy.example.com" },
      });

      expect(lastTokenExchangeBody()?.get("redirect_uri")).toBe(
        "https://configured.example.com/api/oauth/callback",
      );
    });

    it("derives from x-forwarded-* when env is unset", async () => {
      const state = issueOAuthState();

      await makeApp().request(`http://localhost${CALLBACK}?code=abc&state=${state}`, {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "proxy.example.com" },
      });

      expect(lastTokenExchangeBody()?.get("redirect_uri")).toBe(`https://proxy.example.com${CALLBACK}`);
    });

    it("falls back to the request origin when no proxy headers exist", async () => {
      const state = issueOAuthState();

      await makeApp().request(`http://localhost${CALLBACK}?code=abc&state=${state}`);

      expect(lastTokenExchangeBody()?.get("redirect_uri")).toBe(`http://localhost${CALLBACK}`);
    });

    it("never derives the redirect_uri from the state parameter", async () => {
      // 旧实现：redirectUri = atob(state)。攻击者构造任意 base64 state 即可指定回调地址。
      const attackerState = Buffer.from("https://evil.example.com/steal").toString("base64");
      const res = await makeApp().request(
        `http://localhost${CALLBACK}?code=abc&state=${encodeURIComponent(attackerState)}`,
      );

      expect(res.status).toBe(400); // 伪造 state 直接拒，且不发起 token exchange
      expect(lastTokenExchangeBody()).toBeNull();
    });
  });
});
