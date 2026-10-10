import { describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, randomBytes } from "crypto";
import { encryptBuffer, decryptBuffer } from "./crypto";

/**
 * 旧格式（v1，SHA-256 派生）密文样本构造器——**兼容性锁**：
 * v1 布局 `iv(12) || tag(16) || ct`，密钥 = SHA-256(envKey)。
 * 修复 M5（scrypt 加固）后，所有存量备份（含每日 701MB 全量）仍是此格式，
 * decryptBuffer 必须永久可解，否则备份体系断裂。
 */
function encryptLegacyBuffer(plain: Buffer, envKey: string): Buffer {
  const key = createHash("sha256").update(envKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

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

describe("M5 KDF 加固（scrypt 派生 + 版本头）", () => {
  it("新格式带版本头：MAGIC(4) || kdfId(1) || salt(16) || iv(12) || tag(16)", () => {
    const encrypted = encryptBuffer(Buffer.from("v2 payload"), "k".repeat(32));
    expect(encrypted.length).toBeGreaterThanOrEqual(4 + 1 + 16 + 12 + 16 + 1);
    // MAGIC 4 字节（实现内定义，此处锁定其稳定性——所有新备份共用）
    expect(encrypted.subarray(0, 4).toString("ascii")).toBe("XJBK"); // 璇玑备份
    expect(encrypted[4]).toBe(2); // kdfId=2 (scrypt)；1 保留给未来 KDF
  });

  it("旧格式（存量备份）永久可解——SHA-256 派生兼容锁", () => {
    const key = "legacy-key-still-must-decrypt";
    const plain = Buffer.from("存量 701MB 备份的解密权");
    const legacy = encryptLegacyBuffer(plain, key);
    // 旧格式无版本头：首 4 字节是 IV 的一部分（随机），不可能是 MAGIC
    expect(legacy.subarray(0, 4).toString("ascii")).not.toBe("XJBK");
    expect(decryptBuffer(legacy, key)).toEqual(plain);
  });

  it("新格式盐随机：同钥同明文两次加密 salt 段不同", () => {
    const key = "s".repeat(32);
    const a = encryptBuffer(Buffer.from("same"), key);
    const b = encryptBuffer(Buffer.from("same"), key);
    // salt 段 [5,21) 随机
    expect(a.subarray(5, 21).equals(b.subarray(5, 21))).toBe(false);
  });

  it("弱密钥（<16 字符）加密时 console.warn 提示但放行（兼容现有部署）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const encrypted = encryptBuffer(Buffer.from("weak key scenario"), "short");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/BACKUP_ENCRYPTION_KEY/);
    expect(decryptBuffer(encrypted, "short")).toEqual(Buffer.from("weak key scenario"));
    vi.restoreAllMocks();
  });

  it("篡改新格式 salt 段 → GCM tag 校验失败拒绝", () => {
    const encrypted = encryptBuffer(Buffer.from("sensitive"), "k".repeat(32));
    encrypted[10] ^= 0xff; // 翻转 salt 段一个字节 → 派生错钥 → tag 不匹配
    expect(() => decryptBuffer(encrypted, "k".repeat(32))).toThrow();
  });
});
