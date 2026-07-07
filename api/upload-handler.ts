/**
 * 文件上传处理器
 * 直接挂载到 Hono 路由，处理 multipart 文件上传
 */
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { uploadedFiles, type UploadedFile } from "@db/schema";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { env } from "./lib/env";

const UPLOAD_DIR = path.resolve(env.uploadDir);
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const FALLBACK_MIME_TYPE = "application/octet-stream";

const ALLOWED_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf",
  "text/plain", "text/markdown", "text/csv",
  "application/json", "application/xml", "text/xml",
  "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip", "application/gzip", "application/x-7z-compressed", "application/x-tar",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm", "audio/flac",
  "video/mp4", "video/mpeg", "video/quicktime", "video/webm", "video/x-msvideo",
]);

const SAFE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-7z-compressed": ".7z",
  "application/x-tar": ".tar",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/webm": ".weba",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/mpeg": ".mpeg",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-msvideo": ".avi",
};

const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".sh", ".bash", ".bat", ".cmd", ".ps1",
  ".js", ".ts", ".py", ".rb", ".php", ".pl", ".go", ".rs",
  ".jar", ".war", ".class",
  ".scr", ".msi", ".apk", ".app",
  ".html", ".htm", ".svg", ".xml",
]);

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
  const ext = path.extname(file.name).toLowerCase();

  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`不允许的文件类型: ${ext}`);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error("单个文件不能超过 20MB");
  }

  const reportedMimeType = file.type || FALLBACK_MIME_TYPE;
  const mimeType = ALLOWED_MIMES.has(reportedMimeType) ? reportedMimeType : FALLBACK_MIME_TYPE;
  if (!ALLOWED_MIMES.has(reportedMimeType)) {
    console.warn(`[Upload] 未知 MIME 类型按 ${FALLBACK_MIME_TYPE} 保存: ${file.type || "(empty)"} for ${file.name}`);
  }

  const safeExt = SAFE_EXTENSION_BY_MIME[mimeType] ?? ".bin";
  const uniqueName = `${randomUUID()}${safeExt}`;
  const storagePath = path.join(UPLOAD_DIR, uniqueName);

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(storagePath, buffer);

  const db = getDb();
  let result;
  const insertValues = {
    filename: uniqueName,
    originalName: file.name,
    mimeType,
    size: file.size,
    storagePath: storagePath,
    metadata: { uploadedAt: new Date().toISOString() },
    uploadedBy: uploadedBy ?? null,
  };

  try {
    result = await db.insert(uploadedFiles).values(insertValues);
  } catch (err) {
    console.error("[saveUploadedFile] DB insert failed:", err);
    throw new Error("文件保存失败");
  }

  const id = Number(result[0].insertId);

  return {
    id,
    filename: uniqueName,
    originalName: file.name,
    mimeType,
    size: file.size,
    storagePath,
    url: `/api/files/${id}`,
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

  const filePath = path.resolve(UPLOAD_DIR, file.storagePath);
  if (filePath.startsWith(`${UPLOAD_DIR}${path.sep}`) && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  await db.delete(uploadedFiles).where(eq(uploadedFiles.id, id));
  return true;
}

/** 提供文件下载 */
export async function getFileStream(id: number): Promise<{
  stream: fs.ReadStream;
  file: UploadedFile;
} | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(uploadedFiles)
    .where(eq(uploadedFiles.id, id));

  const file = rows[0];
  if (!file) return null;

  const filePath = path.resolve(UPLOAD_DIR, file.storagePath);
  if (!filePath.startsWith(`${UPLOAD_DIR}${path.sep}`)) return null;
  if (!fs.existsSync(filePath)) return null;

  return { stream: fs.createReadStream(filePath), file };
}
