/**
 * 流式写入工具：把 Readable 流（Web ReadableStream / Node Readable）写入目标文件路径，
 * 实时累计字节数并在超过 maxBytes 时主动销毁流、清理已写文件。
 *
 * 解决「一次性 readFileSync 全文件 + writeFileSync」对大文件（>20MB）会撑爆内存的问题。
 * 配合 file.size 上限检查（Web File 的 size 在 metadata 里，不读 body）做双重保护。
 */
import { createWriteStream } from "fs";
import { mkdir, rm, stat } from "fs/promises";
import { dirname } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

/** Web ReadableStream（fetch/file.stream()）与 Node Readable 互转，统一为 Node Readable。 */
function toNodeReadable(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream): NodeJS.ReadableStream {
  // Node 18+ Readable.fromWeb / Readable.toWeb 互转
  if (typeof (stream as Readable).pipe === "function") {
    return stream as NodeJS.ReadableStream;
  }
  return Readable.fromWeb(stream as unknown as import("stream/web").ReadableStream);
}

export interface StreamToFileResult {
  bytesWritten: number;
  /** 上限检测是否触发（与 maxBytes 配合使用，触发即抛错并清理文件） */
  limitExceeded: boolean;
}

export class StreamSizeLimitError extends Error {
  readonly name = "StreamSizeLimitError";
  constructor(public readonly limitBytes: number, public readonly writtenBytes: number) {
    super(`stream exceeded size limit: ${writtenBytes} > ${limitBytes} bytes`);
  }
}

/**
 * 流式写入；累计字节数；超过 maxBytes 时立即终止流、删除已写文件并抛错。
 * 注意：maxBytes=0 表示不设上限。
 */
export async function streamToFileWithLimit(
  source: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  destPath: string,
  maxBytes: number = 0,
): Promise<StreamToFileResult> {
  await mkdir(dirname(destPath), { recursive: true });

  const nodeStream = toNodeReadable(source);
  let bytesWritten = 0;
  let limitExceeded = false;

  // 包装：监控每个 chunk
  const counter = new Readable({
    read() {},
  });
  nodeStream.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (maxBytes > 0 && bytesWritten + buf.length > maxBytes) {
      limitExceeded = true;
      counter.destroy(new StreamSizeLimitError(maxBytes, bytesWritten + buf.length));
      // 截断：只 push 还能接受的部分
      const remaining = Math.max(0, maxBytes - bytesWritten);
      if (remaining > 0) {
        counter.push(buf.subarray(0, remaining));
        bytesWritten += remaining;
      }
      counter.push(null);
      return;
    }
    bytesWritten += buf.length;
    counter.push(buf);
  });
  nodeStream.on("end", () => counter.push(null));
  nodeStream.on("error", (e) => counter.destroy(e));

  const ws = createWriteStream(destPath);
  try {
    await pipeline(counter, ws);
  } catch (err) {
    // 清理已写的部分文件
    await rm(destPath, { force: true });
    if (err instanceof StreamSizeLimitError) throw err;
    throw err;
  }

  if (limitExceeded) {
    // 理论上 pipeline 会先抛 StreamSizeLimitError；这里兜底
    await rm(destPath, { force: true });
    throw new StreamSizeLimitError(maxBytes, bytesWritten);
  }
  return { bytesWritten, limitExceeded: false };
}

/** 读取文件大小，便于校验。 */
export async function getFileSize(path: string): Promise<number> {
  const s = await stat(path);
  return s.size;
}
