import { afterEach, describe, expect, it } from "vitest";
import { getSessionCookieOptions } from "./cookies";

describe("session cookie options", () => {
  afterEach(() => {
    delete process.env.COOKIE_SAMESITE;
  });

  it("defaults SameSite to Lax for non-localhost requests", () => {
    // Given: a production host without an explicit cross-site cookie override.
    const headers = new Headers({ host: "xuanji.example.com" });

    // When: session cookie options are built.
    const options = getSessionCookieOptions(headers);

    // Then: SameSite remains Lax while secure stays enabled for non-localhost.
    expect(options.sameSite).toBe("Lax");
    expect(options.secure).toBe(true);
  });

  it("allows SameSite None only when COOKIE_SAMESITE is explicit", () => {
    // Given: an explicit cross-site cookie override for iframe or embedded deployments.
    process.env.COOKIE_SAMESITE = "None";
    const headers = new Headers({ host: "xuanji.example.com" });

    // When: session cookie options are built.
    const options = getSessionCookieOptions(headers);

    // Then: SameSite=None is opt-in and secure behavior is unchanged.
    expect(options.sameSite).toBe("None");
    expect(options.secure).toBe(true);
  });
});
