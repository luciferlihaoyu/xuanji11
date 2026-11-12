/**
 * t16 —— `GET /api/upload/:id/ingestion`（api/boot.ts）的 JSON 数字 vs TEXT 存储类缺陷。
 *
 * 为什么这个文件值得存在：这条查询就是"查了、SQL 合法、返回 0 行"那一类 bug，
 * 桩（vi.mock 掉 db）永远测不出来——桩只会照我说"命中"就命中。所以这里全部走真链路：
 *   · 真 Hono app：直接 import api/boot.ts 导出的 default，用 app.request() 打真实路由
 *     （csrfMiddleware + authMiddleware + 路由 handler 一个都不跳过）
 *   · 真会话：local-auth.signLocalToken 签发 HS256 cookie，过 authenticateLocalRequest
 *   · 真 SQLite：SQLITE_PATH 指向 /tmp 临时文件，boot.ts 的 runMigrations() 用**仓库真实
 *     migrations** 建表（不是手写 DDL），落库走 drizzle `mode:"json"` 序列化器
 *     （与 api/lib/ingestion.ts:185 的 `uploadedFileId: uploadedFileId ?? null` 同口径 → JSON 数字）
 *   · 真比较：断言的是 res.json().items，不是任何中间量
 *
 * 覆盖边界（务必如实看待）：这验证到"HTTP 请求 → 中间件 → handler → SQL → 真库 → 响应体"，
 * 但不覆盖浏览器里的 src/pages/UploadPage.tsx 轮询循环本身（那需要前端 e2e，本容器不跑）。
 * 用例 1 的断言条件 `success && items.length > 0` 正是 UploadPage:68 用来写 ingestionStatus、
 * 进而停掉 2 秒轮询的那个判断，所以它对得上用户可见症状，但**不等于**跑过浏览器。
 *
 * 同款缺陷先例：api/lib/document-node-match.ts（2026-09-22 线上 graph_orphans 事故）、
 * api/datasource-router.ts:294（t14）、api/ingestion-router.ts:63（t15，本路由的孪生查询）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { Session } from "@contracts/constants";
import { ingestionItems, ingestionJobs } from "@db/schema";
import { env } from "./lib/env";
import { getDb, getRawDb } from "./queries/connection";
import { signLocalToken } from "./local-auth";

// 必须在任何 ./lib/env / ./boot 求值之前落定环境变量（env.ts 缺 ADMIN_* 会 process.exit(1)，
// 且 sqlitePath 在模块初始化时就固化）。vi.hoisted 保证这些赋值先于 import 执行。
// 注意：hoisted 块会被提到 import 之前，里面**不能**用 os/path 等模块（会 TDZ），故写死路径。
vi.hoisted(() => {
  process.env.NODE_ENV = "test"; // 非 production → boot.ts 不会 serve()、不会起调度器
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
  process.env.SQLITE_PATH = "/tmp/xuanji-t16-boot-e2e.db";
  // boot.ts 的模块图会把这几个目录拿去做 mkdir/清理（lib/ingestion.ts、backup-scheduler），
  // 默认值都是 /data/app/*（本容器不可写，且**绝不该**被测试碰）——一并钉到 /tmp 沙箱里。
  process.env.UPLOAD_DIR = "/tmp/xuanji-t16-boot-e2e/uploads";
  process.env.BACKUP_TEMP_DIR = "/tmp/xuanji-t16-boot-e2e/backups";
  process.env.ZVEC_DATA_DIR = "/tmp/xuanji-t16-boot-e2e";
});

/** 本测试专用的一次性数据库（绝不碰 /data/app/xuanji.db 等真实库）。 */
const DB_PATH = process.env.SQLITE_PATH as string;
/** 固定的 ingestion_jobs.id：items 表有指向 jobs 的外键，且 getRawDb() 开了 foreign_keys=ON。 */
const JOB_ID = 900_001;

type BootApp = (typeof import("./boot"))["default"];
type Item = { id: number; name: string; status: string; error: string | null; metadata: Record<string, unknown> | null };
type Body = { success: boolean; items?: Item[]; error?: string };

let app: BootApp;
let raw: Database.Database;
let sessionCookie: string;

function rmDbArtifacts(): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.rmSync(DB_PATH + suffix, { force: true });
    } catch {
      /* 清不掉不影响测试正确性（beforeAll 里还会再删一次） */
    }
  }
  try {
    fs.rmSync("/tmp/xuanji-t16-boot-e2e", { recursive: true, force: true });
  } catch {
    /* 同上 */
  }
}

/** 照生产落库口径写一行 ingestion_items：metadata 交 drizzle `mode:"json"` 序列化。 */
async function seedItem(
  name: string,
  metadata: Record<string, unknown>,
  createdAt: Date = new Date("2026-01-01T00:00:00Z"),
): Promise<void> {
  await getDb()
    .insert(ingestionItems)
    .values({
      jobId: JOB_ID,
      externalId: null,
      name,
      mimeType: "text/markdown",
      size: 12,
      status: "completed",
      error: null,
      sourceUrl: null,
      storagePath: null,
      documentId: null,
      metadata,
      createdAt,
      updatedAt: createdAt,
    });
}

/** 真 HTTP 请求：GET /api/upload/:id/ingestion（带 / 不带会话 cookie）。 */
async function getIngestion(id: string | number, authed = true): Promise<{ status: number; body: Body }> {
  const headers = new Headers();
  if (authed) headers.set("cookie", `${Session.cookieName}=${sessionCookie}`);
  const res = await app.request(`http://localhost/api/upload/${id}/ingestion`, { headers });
  return { status: res.status, body: (await res.json()) as Body };
}

/** 取某行 metadata 里那个键的 SQLite 存储类（integer / text / null / …）。 */
function jsonTypeOf(name: string, key: string): string | null {
  const row = raw
    .prepare(`SELECT json_type(metadata, '$.${key}') AS t FROM ingestion_items WHERE name = ?`)
    .get(name) as { t: string | null } | undefined;
  return row?.t ?? null;
}

function countWhere(where: string): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ingestion_items WHERE ${where}`).get() as { n: number }).n;
}

beforeAll(async () => {
  // 安全闸门：boot.ts 一 import 就会 runMigrations()，路径必须是本测试的临时库。
  if (env.sqlitePath !== DB_PATH) {
    throw new Error(`SQLite 路径不是测试专用临时库（got ${env.sqlitePath}，want ${DB_PATH}），拒绝继续以免写坏真实数据`);
  }
  rmDbArtifacts();

  const boot = await import("./boot"); // 副作用：建库 + 跑真实 migrations
  app = boot.default;
  raw = getRawDb();

  await getDb().insert(ingestionJobs).values({
    id: JOB_ID,
    sourceType: "upload",
    status: "completed",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  // t17 要打 POST /api/upload：`uploaded_files.uploadedBy` 有指向 users(id) 的外键，而
  // authenticateLocalRequest 查不到 local_accounts 行时会回退 user.id = 1（local-auth.ts:228）。
  // 不种这一行，真实链路会在 saveUploadedFile 落库处 FOREIGN KEY constraint failed（500）——
  // 那是**测试脚手架**缺口（本容器里没人登录过，users 表空），不是被测行为，故在此补齐。
  raw.prepare(`INSERT OR IGNORE INTO users (id, unionId, name, role) VALUES (1, 'local_admin', 'admin', 'admin')`).run();
  sessionCookie = await signLocalToken("admin");
});

afterAll(() => {
  try {
    getRawDb().close();
  } catch {
    /* 已关闭 */
  }
  rmDbArtifacts();
});

describe("t16 端到端：GET /api/upload/:id/ingestion 必须真的命中（真 app + 真 SQLite）", () => {
  it("主用例：数字型 uploadedFileId 的已入库行必须返回（修复前恒返回空数组）", async () => {
    await seedItem("已入库.md", { uploadedFileId: 7 });

    // 先钉死"落库形态与生产一致"：这个键是 **JSON 数字**（integer）。
    // 若哪天有人把它写成 "7"，本行会红——而不是让下面的用例假绿。
    expect(jsonTypeOf("已入库.md", "uploadedFileId")).toBe("integer");

    const { status, body } = await getIngestion(7);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items?.[0]?.name).toBe("已入库.md");
    expect(body.items?.[0]?.metadata).toMatchObject({ uploadedFileId: 7 });

    // 直接对上用户可见症状：UploadPage.tsx:68 用 `success && items.length > 0`
    // 才写 ingestionStatus（进而停掉 2 秒轮询）。空数组 = 状态永不落地 = 轮询永不停止。
    expect(Boolean(body.success && body.items && body.items.length > 0)).toBe(true);
    expect(body.items?.[0]?.status).toBe("completed");
  });

  it("根因锚点（真表真库）：同一行数据，裸比较 0 命中，CAST AS TEXT 命中", () => {
    // 把 SQLite 的存储类语义在测试里钉死：将来有人拆掉 CAST，用例 1 会红；
    // 有人以为"数字跟数字比就行"，这一条会告诉他代码里传的是 String(id)。
    expect(countWhere(`json_extract(metadata, '$.uploadedFileId') = '7'`)).toBe(0);
    expect(countWhere(`json_extract(metadata, '$.uploadedFileId') = 7`)).toBe(1);
    expect(countWhere(`CAST(json_extract(metadata, '$.uploadedFileId') AS TEXT) = '7'`)).toBe(1);
    // 旧写法（->> 运算符）同款恒不命中，一并钉住，免得有人"改进"成 ->> 又踩回去
    expect(countWhere(`metadata->>'$.uploadedFileId' = '7'`)).toBe(0);
  });

  it("历史行把 uploadedFileId 存成 JSON 字符串 → 也必须命中（CAST 对两种形态都成立）", async () => {
    await seedItem("旧数据-字符串.md", { uploadedFileId: "7" });
    expect(jsonTypeOf("旧数据-字符串.md", "uploadedFileId")).toBe("text");

    const { body } = await getIngestion(7);
    const names = body.items?.map((i) => i.name) ?? [];
    expect(names).toContain("旧数据-字符串.md");
    expect(names).toContain("已入库.md");
  });

  it("其它通路（uploadedFileId 为 JSON null / 无此键）绝不允许被误命中", async () => {
    // datasource 通路的每一行都带 uploadedFileId: null（ingestion.ts:185）；
    // 若把比较写成"字符串化的 null 也相等"，这些行会全部串进某个具体文件。
    await seedItem("网盘条目-1.md", { uploadedFileId: null });
    await seedItem("手工条目-无此键.md", { source: "manual" });

    const { body } = await getIngestion(7);
    const names = (body.items ?? []).map((i) => i.name).sort();
    expect(names).toEqual(["已入库.md", "旧数据-字符串.md"]);
  });

  it("不同文件 id 不得串味；没入库过的文件返回空数组", async () => {
    await seedItem("八号.md", { uploadedFileId: 8 });

    expect((await getIngestion(8)).body.items?.map((i) => i.name)).toEqual(["八号.md"]);
    const missing = await getIngestion(4242);
    expect(missing.status).toBe(200);
    expect(missing.body.items).toEqual([]);
  });

  it("同一文件多次入库：全部返回且按 createdAt 倒序（前端只取 items[0]）", async () => {
    const fileId = 11;
    await seedItem("第一次.md", { uploadedFileId: fileId }, new Date("2026-01-01T00:00:00Z"));
    await seedItem("第三次.md", { uploadedFileId: fileId }, new Date("2026-03-01T00:00:00Z"));
    await seedItem("第二次.md", { uploadedFileId: fileId }, new Date("2026-02-01T00:00:00Z"));

    const { body } = await getIngestion(fileId);
    expect(body.items?.map((i) => i.name)).toEqual(["第三次.md", "第二次.md", "第一次.md"]);
  });

  it("未登录仍然 401 —— 改动没有绕过鉴权中间件", async () => {
    const { status, body } = await getIngestion(7, false);
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  it("非法 id（非数字 / 0 / 负数）仍然 400，不会落到 SQL", async () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const { status, body } = await getIngestion(bad);
      expect(status, `id=${bad}`).toBe(400);
      expect(body.success).toBe(false);
    }
  });

  it("源码守卫：boot.ts 里 uploadedFileId 的 JSON 比较必须被 CAST 包住（防第四次复发）", async () => {
    // 与 api/ingestion-router.test.ts:225（t15）、api/mcp-document-delete.test.ts 同一手法；
    // 全仓口径由 api/lib/json-sql-guard.test.ts 兜底。
    const source = fs.readFileSync(new URL("./boot.ts", import.meta.url), "utf8");
    expect(source).toMatch(/CAST\(json_extract\(\$\{ingestionItems\.metadata\},\s*'\$\.uploadedFileId'\)\s*AS TEXT\)/);
    expect(source).not.toMatch(/json_extract\(\$\{ingestionItems\.metadata\},\s*'\$\.uploadedFileId'\)\s*=\s*\$\{String/);
  });
});

/**
 * t17 —— `POST /api/upload`（api/boot.ts）的上传页假成功。
 *
 * 为什么这个文件里必须再加这一组：
 *   ingestion.ts 的 `ingestFile()` 对「文档已入库但索引失败」**不再抛错**，而是如实回报
 *   `{ indexed: false, indexError }`（嵌入服务挂掉、格式不支持、正文为空……）。而 boot.ts 的
 *   /api/upload 旧实现只 catch 抛错、**完全忽略返回值** → 索引失败这条路一声不响地漏掉了：
 *   上传页弹「成功上传 N 个文件」，那份文档却检索不到。这正是本项目要消灭的头号假成功。
 *
 * 口径（务必分清，别把两种误导对调）：
 *   · `success` 语义仍是「文件已接收」——文件确实落盘了，不能因为索引失败判 success:false
 *     （那会让前端弹「上传失败」而文件其实在，属另一种误导）；
 *   · 索引失败走 `ingestionErrors` 数组，元素形如 `{ file, error: "索引失败：<原因>" }`，
 *     由前端展示（UploadPage.tsx 现有字段，未改名）。
 *
 * 覆盖边界：真 app + 真 SQLite + 真 ingestFile（不 mock），但**不等于**跑过浏览器 ——
 * UploadPage.tsx 里 ingestionErrors 的渲染是人工核验项（见交付汇报的人工核验清单）。
 */
describe("t17 端到端：POST /api/upload 必须如实回报索引失败（消灭上传页假成功）", () => {
  type UploadError = { file: string; error: string };
  type UploadBody = {
    success: boolean;
    files?: { id: number; originalName: string; url?: string }[];
    count?: number;
    ingestionErrors?: UploadError[];
    error?: string;
  };

  /**
   * 真 HTTP 请求：POST /api/upload。
   * CSRF 与 UploadPage.tsx:159 同口径 —— 带 `X-Requested-With: XMLHttpRequest`（csrf.ts:44 的免检头）。
   */
  async function postUpload(
    files: readonly { name: string; content: string; type: string }[],
    authed = true,
  ): Promise<{ status: number; body: UploadBody }> {
    const form = new FormData();
    for (const f of files) form.append("files", new File([f.content], f.name, { type: f.type }));
    const headers = new Headers();
    if (authed) headers.set("cookie", `${Session.cookieName}=${sessionCookie}`);
    headers.set("x-requested-with", "XMLHttpRequest");
    const res = await app.request("http://localhost/api/upload", { method: "POST", headers, body: form });
    return { status: res.status, body: (await res.json()) as UploadBody };
  }

  /** 取某次上传在 ingestion_items 里留下的行（证明"文件真进了入库流程"）。 */
  function itemRowOf(name: string): { status: string; error: string | null } | undefined {
    return raw.prepare(`SELECT status, error FROM ingestion_items WHERE name = ? ORDER BY id DESC LIMIT 1`).get(name) as
      | { status: string; error: string | null }
      | undefined;
  }

  it("主用例：文档入库但索引失败 → success 仍为 true（文件确实收到），但 ingestionErrors 必须写明「索引失败：<原因>」", async () => {
    // Given: 一个上传目录收下、但解析器不支持的二进制文件（octet-stream → parseFileToText 返回 supported:false）。
    //        真链路：saveUploadedFile 落盘 + 落库 → ingestFile 建 job/item → 回报 indexed:false。
    const { status, body } = await postUpload([
      { name: "无法解析.bin", content: "not text at all", type: "application/octet-stream" },
    ]);

    // Then: HTTP 200、文件已接收（success:true / count:1），字段名与状态码都没被改动。
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    expect(body.files?.[0]?.originalName).toBe("无法解析.bin");

    // And: 索引失败必须出现在 ingestionErrors 里（修复前这里是 undefined —— 假成功）。
    expect(body.ingestionErrors).toHaveLength(1);
    expect(body.ingestionErrors?.[0]?.file).toBe("无法解析.bin");
    // 措辞按真实原因分档（评审 B3）：格式不支持 ≠ 我们的索引挂了，
    // 说成"索引失败"会把用户引向错误的排查方向。
    expect(String(body.ingestionErrors?.[0]?.error)).toMatch(/^格式不支持/);
    expect(String(body.ingestionErrors?.[0]?.error)).toContain("Unsupported format");

    // And: 入库流程真的走过（item 行存在且状态为 unsupported），不是靠提前 return 蒙出来的。
    expect(itemRowOf("无法解析.bin")).toMatchObject({ status: "unsupported" });
  });

  it("「解析后正文为空」同样是索引失败（能解析但没有可索引内容），也必须出现在 ingestionErrors", async () => {
    // Given: 一个 MIME 合法、内容为空（只有空白）的 markdown。
    const { body } = await postUpload([{ name: "空白.md", content: "   \n\n  ", type: "text/markdown" }]);

    // Then: 文件收下了，但"无可索引内容"要如实说出来，别让用户以为检索得到。
    expect(body.success).toBe(true);
    expect(body.ingestionErrors).toHaveLength(1);
    expect(String(body.ingestionErrors?.[0]?.error)).toBe("未生成可索引文档：解析后正文为空");
  });

  it("多个文件各失败各报，不合并成一条笼统错误", async () => {
    const { body } = await postUpload([
      { name: "坏-1.bin", content: "x", type: "application/octet-stream" },
      { name: "坏-2.bin", content: "y", type: "application/octet-stream" },
    ]);

    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
    expect(body.ingestionErrors?.map((e) => e.file).sort()).toEqual(["坏-1.bin", "坏-2.bin"]);
    for (const e of body.ingestionErrors ?? []) expect(e.error).toMatch(/^格式不支持/);
  });

  it("源码守卫：boot.ts 的 /api/upload 必须消费 ingestFile 的返回值（防再次忽略而复发假成功）", async () => {
    const source = fs.readFileSync(new URL("./boot.ts", import.meta.url), "utf8");
    // 必须接住返回值并读 indexed —— 裸 `await ingestFile({...})` 就是这轮修复前的形态。
    expect(source).toMatch(/const\s+ingested\s*=\s*await\s+ingestFile\(/);
    expect(source).toMatch(/if\s*\(!ingested\.indexed\)/);
    // 既有的"抛错"分支保留不变：入库彻底失败仍然只有这一句文案。
    expect(source).toContain('error: "文件入库失败"');
  });

  it("未登录仍然 401（新逻辑没有绕过鉴权中间件）", async () => {
    const { status, body } = await postUpload(
      [{ name: "无法解析-未登录.bin", content: "z", type: "application/octet-stream" }],
      false,
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });
});
