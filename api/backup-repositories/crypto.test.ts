import { describe, expect, it } from "vitest";
import { encryptBuffer, decryptBuffer } from "./crypto";

describe("backup crypto (AES-256-GCM)", () => {
  it("roundtrips a buffer with the same key", () => {
    const key = "k".repeat(32);
    const plain = Buffer.from("hello backup bundle");
    const encrypted = encryptBuffer(plain, key);
    expect(encrypted).not.toEqual(plain);
    expect(decryptBuffer(encrypted, key)).toEqual(plain);
  });

  it("produces a fresh IV per encryption so ciphertexts differ", () => {
    const key = "x".repeat(32);
    const plain = Buffer.from("same content");
    expect(encryptBuffer(plain, key)).not.toEqual(encryptBuffer(plain, key));
  });

  it("detects tampered ciphertext", () => {
    const key = "y".repeat(32);
    const encrypted = encryptBuffer(Buffer.from("sensitive"), key);
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => decryptBuffer(encrypted, key)).toThrow();
  });

  it("rejects decryption with the wrong key", () => {
    const encrypted = encryptBuffer(Buffer.from("sensitive"), "a".repeat(32));
    expect(() => decryptBuffer(encrypted, "b".repeat(32))).toThrow();
  });

  it("rejects an empty environment key", () => {
    expect(() => encryptBuffer(Buffer.from("x"), "")).toThrow();
    expect(() => decryptBuffer(Buffer.from("x"), "")).toThrow();
  });
});
