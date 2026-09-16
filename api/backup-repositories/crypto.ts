/**
 * 备份包加密：AES-256-GCM，随机 12 字节 IV 前置。
 *
 * 密文布局：`iv(12) || authTag(16) || ciphertext`
 * 密钥来自环境变量 BACKUP_ENCRYPTION_KEY，经 SHA-256 派生为 32 字节。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(envKey: string): Buffer {
  if (!envKey) {
    throw new Error("BACKUP_ENCRYPTION_KEY 未配置，无法执行加密/解密");
  }
  return createHash("sha256").update(envKey).digest();
}

/** 流式加密文件到磁盘（大文件防 OOM）：格式与 encryptBuffer 完全一致（iv+tag+ciphertext） */
export async function encryptFileToFile(srcPath: string, destPath: string, envKey: string): Promise<void> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const key = deriveKey(envKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // 先写 iv（12B），tag 留洞（16B 零），流式写密文，结束回填 tag
  const out = createWriteStream(destPath);
  out.write(iv);
  out.write(Buffer.alloc(TAG_LENGTH));
  await pipeline(createReadStream(srcPath), cipher, out, { end: true });
  const tag = cipher.getAuthTag();
  const { open } = await import("node:fs/promises");
  const fh = await open(destPath, "r+");
  try {
    await fh.write(tag, 0, TAG_LENGTH, IV_LENGTH);
  } finally {
    await fh.close();
  }
}

export function encryptBuffer(buffer: Buffer, envKey: string): Buffer {
  const key = deriveKey(envKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptBuffer(encrypted: Buffer, envKey: string): Buffer {
  const key = deriveKey(envKey);
  if (encrypted.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("密文长度非法，数据可能已损坏");
  }
  const iv = encrypted.subarray(0, IV_LENGTH);
  const tag = encrypted.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
