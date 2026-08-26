import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { streamToFileWithLimit, StreamSizeLimitError } from "./stream-to-file";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function nodeStreamFromBuffer(buf: Buffer): NodeJS.ReadableStream {
  return Readable.from([buf]);
}

describe("streamToFileWithLimit", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir("stream-to-file-");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("正常小文件流式写入字节数正确", async () => {
    const buf = Buffer.from("hello world");
    const dest = join(dir, "out.bin");
    const r = await streamToFileWithLimit(nodeStreamFromBuffer(buf), dest, 0);
    expect(r.bytesWritten).toBe(11);
    expect(readFileSync(dest).toString()).toBe("hello world");
  });

  it("maxBytes=0 表示不设上限，正常写完", async () => {
    const buf = Buffer.alloc(1024 * 100, 0x41);
    const dest = join(dir, "big.bin");
    const r = await streamToFileWithLimit(nodeStreamFromBuffer(buf), dest, 0);
    expect(r.bytesWritten).toBe(1024 * 100);
    expect(statSync(dest).size).toBe(1024 * 100);
  });

  it("超过 maxBytes 时抛 StreamSizeLimitError 并删除已写部分", async () => {
    // 构造 1MB 数据但限 100 字节
    const buf = Buffer.alloc(1024 * 1024, 0x42);
    const dest = join(dir, "overflow.bin");
    await expect(streamToFileWithLimit(nodeStreamFromBuffer(buf), dest, 100))
      .rejects.toThrow(StreamSizeLimitError);
    // 文件应被清理
    expect(existsSync(dest)).toBe(false);
  });

  it("刚好等于 maxBytes 时通过", async () => {
    const buf = Buffer.alloc(100, 0x43);
    const dest = join(dir, "exact.bin");
    const r = await streamToFileWithLimit(nodeStreamFromBuffer(buf), dest, 100);
    expect(r.bytesWritten).toBe(100);
    expect(statSync(dest).size).toBe(100);
  });

  it("多分块流（chunk-by-chunk）累计字节正确", async () => {
    // 模拟 Web 风格：多分块进入
    const chunks = [Buffer.from("aa"), Buffer.from("bbb"), Buffer.from("cccc")];
    const dest = join(dir, "multi.bin");
    const r = await streamToFileWithLimit(Readable.from(chunks), dest, 0);
    expect(r.bytesWritten).toBe(2 + 3 + 4);
    expect(readFileSync(dest).toString()).toBe("aabbbcccc");
  });

  it("自动创建中间目录", async () => {
    const buf = Buffer.from("ok");
    const dest = join(dir, "a", "b", "c", "out.bin");
    await streamToFileWithLimit(nodeStreamFromBuffer(buf), dest, 0);
    expect(readFileSync(dest).toString()).toBe("ok");
  });
});
