/**
 * 文件上传处理器
 * 直接挂载到 Hono 路由，处理 multipart 文件上传
 */
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { uploadedFiles } from "@db/schema";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/** 保存上传的文件到本地磁盘 */
export async function saveUploadedFile(
  file: File,
  uploadedBy?: number,
): Promise<{
  id: number;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  storagePath: string;
  url: string;
}> {
  // ... existing validation ...
  const ALLOWED_MIMES = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
    "application/pdf",
    "text/plain", "text/markdown", "text/csv", "text/html", "text/css",
    "application/json", "application/xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip", "application/gzip",
    "audio/mpeg", "audio/wav", "audio/ogg",
    "video/mp4", "video/webm",
  ]);

  const ext = path.extname(file.name).toLowerCase();
  const BLOCKED_EXTENSIONS = new Set([
    ".exe", ".dll", ".so", ".sh", ".bash", ".bat", ".cmd", ".ps1",
    ".js", ".ts", ".py", ".rb", ".php", ".pl", ".go", ".rs",
    ".jar", ".war", ".class",
    ".scr", ".msi", ".apk", ".app",
  ]);

  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`不允许的文件类型: ${ext}`);
  }

  const mimeType = file.type || "application/octet-stream";
  if (!ALLOWED_MIMES.has(mimeType)) {
    // 允许未知 MIME 但记录警告
    console.warn(`[Upload] 未知 MIME 类型: ${mimeType} for ${file.name}`);
  }
  const uniqueName = `${randomUUID()}${ext}`;
  const storagePath = path.join(UPLOAD_DIR, uniqueName);

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(storagePath, buffer);

  const db = getDb();
  let result;
  const insertValues = {
    filename: uniqueName,
    originalName: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    storagePath: storagePath,
    metadata: { uploadedAt: new Date().toISOString() },
    uploadedBy: uploadedBy ?? null,
  };

  try {
    result = await db.insert(uploadedFiles).values(insertValues);
  } catch (err) {
    console.error("[saveUploadedFile] DB insert failed:", err);
    console.error("[saveUploadedFile] Insert values:", JSON.stringify(insertValues, null, 2));
    throw new Error(
      `Failed query: insert into uploaded_files - ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const id = Number(result[0].insertId);

  return {
    id,
    filename: uniqueName,
    originalName: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    storagePath,
    url: `/api/files/${uniqueName}`,
  };
}

/** 删除上传的文件 */
export async function deleteUploadedFile(id: number): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select()
    .from(uploadedFiles)
    .where(eq(uploadedFiles.id, id));

  const file = rows[0];
  if (!file) return false;

  if (fs.existsSync(file.storagePath)) {
    fs.unlinkSync(file.storagePath);
  }

  await db.delete(uploadedFiles).where(eq(uploadedFiles.id, id));
  return true;
}

/** 提供文件下载 */
export function getFileStream(filename: string) {
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return { stream: fs.createReadStream(filePath), mimeType: "application/octet-stream" };
}

/** 获取文件磁盘路径 */
export function getFilePath(filename: string): string | null {
  const filePath = path.join(UPLOAD_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}
