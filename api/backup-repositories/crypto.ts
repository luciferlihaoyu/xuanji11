/**
 * 备份包加密：AES-256-GCM，随机 12 字节 IV 前置。
 *
 * M5 加固（v2 审查闭环）：密钥派生从裸 SHA-256（无盐无迭代，弱口令可离线暴力）
 * 升级为 scrypt（N=2^15, r=8, p=1，盐随机）。
 *
 * 密文布局两代并存，解密按版本头自动分流：
 * - v2（新）：`MAGIC("XJBK",4) || kdfId(1)=2 || salt(16) || iv(12) || authTag(16) || ciphertext`
 * - v1（存量）：`iv(12) || authTag(16) || ciphertext`，密钥 = SHA-256(envKey)
 *
 * 兼容性承诺：v1 格式**永久**可解（存量每日 701MB 全量备份是运维命脉，
 * crypto.test.ts 有"旧格式兼容锁"用例锁定此承诺）。升级部署后新备份一律
 * v2；旧备份继续用原 BACKUP_ENCRYPTION_KEY 解密。
 *
 * 弱密钥通告：envKey 长度 < 16 字符时加密侧 console.warn（不硬拒——硬拒会让
 * 既有部署升级后备份静默失败，比弱 KDF 更危险）。部署侧应配置 32+ 随机串。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
/** 版本头：4 字节 ASCII（璇玑备份），kdfId: 2=scrypt（1 保留） */
const MAGIC = Buffer.from("XJBK", "ascii");
const KDF_ID_SCRYPT = 2;
/** scrypt 参数：N=2^15 内存约 32MB（备份进程本就重，可接受）；maxmem 显式放宽防默认 32MB 卡边 */
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function requireEnvKey(envKey: string): string {
  if (!envKey) {
    throw new Error("BACKUP_ENCRYPTION_KEY 未配置，无法执行加密/解密");
  }
  if (envKey.length < 16) {
    console.warn(
      `[BackupCrypto] BACKUP_ENCRYPTION_KEY 长度 ${envKey.length} < 16，弱密钥有离线暴力风险；建议配置 32+ 随机串`,
    );
  }
  return envKey;
}

/** v2：scrypt 派生（盐随密文存储）。 */
function deriveKeyV2(envKey: string, salt: Buffer): Buffer {
  return scryptSync(envKey, salt, 32, SCRYPT_PARAMS);
}

/** v1：裸 SHA-256 派生——仅为存量备份解密保留，新加密禁止使用。 */
function deriveKeyV1(envKey: string): Buffer {
  return createHash("sha256").update(envKey).digest();
}

/** 流式加密文件到磁盘（大文件防 OOM）：v2 格式（版本头+盐+iv+tag+ciphertext） */
export async function encryptFileToFile(srcPath: string, destPath: string, envKey: string): Promise<void> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const key16 = requireEnvKey(envKey);
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKeyV2(key16, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // 先写版本头+盐+iv，tag 留洞（16B 零），流式写密文，结束回填 tag
  const out = createWriteStream(destPath);
  out.write(MAGIC);
  out.write(Buffer.from([KDF_ID_SCRYPT]));
  out.write(salt);
  out.write(iv);
  out.write(Buffer.alloc(TAG_LENGTH));
  await pipeline(createReadStream(srcPath), cipher, out, { end: true });
  const tag = cipher.getAuthTag();
  const { open } = await import("node:fs/promises");
  const fh = await open(destPath, "r+");
  try {
    // tag 落点 = 4(MAGIC) + 1(kdfId) + 16(salt) + 12(iv)
    await fh.write(tag, 0, TAG_LENGTH, 4 + 1 + SALT_LENGTH + IV_LENGTH);
  } finally {
    await fh.close();
  }
}

export function encryptBuffer(buffer: Buffer, envKey: string): Buffer {
  const key16 = requireEnvKey(envKey);
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKeyV2(key16, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([KDF_ID_SCRYPT]), salt, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBuffer(encrypted: Buffer, envKey: string): Buffer {
  const key16 = requireEnvKey(envKey);
  // 版本分流：v2 命中 MAGIC；v1（存量）无版本头——首 4 字节是随机 IV 前缀，
  // 与 4 字节定值 MAGIC 命中概率 2^-32，视为不可能事件。
  if (encrypted.length >= 4 && encrypted.subarray(0, 4).equals(MAGIC)) {
    if (encrypted.length < 4 + 1 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1) {
      throw new Error("密文长度非法，数据可能已损坏");
    }
    const kdfId = encrypted[4];
    if (kdfId !== KDF_ID_SCRYPT) {
      throw new Error(`未知 KDF 版本 ${kdfId}，备份可能来自更新版本的璇玑`);
    }
    const salt = encrypted.subarray(5, 5 + SALT_LENGTH);
    const iv = encrypted.subarray(5 + SALT_LENGTH, 5 + SALT_LENGTH + IV_LENGTH);
    const tag = encrypted.subarray(5 + SALT_LENGTH + IV_LENGTH, 5 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const ciphertext = encrypted.subarray(5 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const key = deriveKeyV2(key16, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // v1 存量格式：iv(12) || tag(16) || ct，SHA-256 派生
  const key = deriveKeyV1(key16);
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
