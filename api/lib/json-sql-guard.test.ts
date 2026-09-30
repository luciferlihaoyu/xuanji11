/**
 * t16 —— 全仓棘轮守卫：JSON 路径取值参与**相等比较**时必须被 CAST 包住。
 *
 * 立规的原因（同类缺陷已第三次复发，前两次的现场记录）：
 *   · api/lib/document-node-match.ts —— 2026-09-22 线上 graph_orphans 事故（数字型节点永远匹配不上）
 *   · api/datasource-router.ts:294（t14，去重永不命中 → 每轮全量重刷）
 *   · api/ingestion-router.ts:63（t15）+ api/boot.ts:368（t16，上传页轮询永不停止）
 * 机制：SQLite 3.38+ 的 `json_extract()` / `->>` 按**原生存储类**返回值（JSON 数字 → SQL INTEGER），
 * 而 JS 侧绑定的比较值几乎都是 `String(id)`（TEXT）；SQLite 不做 INTEGER↔TEXT 隐式相等 →
 * **查询合法执行、返回 0 行**（不报错，所以极难发现——这正是它藏了这么久的原因）。
 * 对照（t16 实测，sqlite 3.53.4）：普通 TEXT 列与 INTEGER 字面量相比会靠**列亲和性**自动拉平而命中，
 * json_extract 的返回值**没有列亲和性**，所以只有"JSON 取值参与相等比较"这一条必须 CAST。
 *
 * 棘轮（ratchet）语义：命中即红，**允许清单必须为空**。新增命中一律先修（或明确报告），
 * 不允许"顺手加进 allowlist 放行"。
 *
 * 本文件同时是"守卫非空转"的证据：它不只看仓库现状，还在内存字符串 + 临时目录上
 * 分别验证"坏写法必报红 / 好写法必须放行 / 注释与测试文件与 scripts/ 确实被跳过"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/** 仓库根（本文件在 api/lib/ 下，上两级）。 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 不扫描的目录：依赖、产物、版本库、以及一次性脚本（含本仓库历史 /tmp 试跑件）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "scripts", "coverage", ".omo"]);
/** 守卫自身与各域行为测试里必然要写"坏写法"的字符串（自检用例），按文件名后缀跳过。 */
const TEST_FILE = /\.(test|spec)\.[cm]?[tj]sx?$/;

/** JSON 路径字面量：'$.key' / "$.a.b" / '$."key"' 都算。 */
const JSON_PATH_LITERAL = /["']\$\.[^"']*["']/;
/** 相等类比较（SQL 里生效的写法；`IS [NOT] NULL` 与 `LIKE` 不受存储类影响，故不在表内）。 */
const EQUALITY_COMPARISON: readonly RegExp[] = [/\s=\s/, /\s==\s/, /!=/, /<>/, /\s+IN\s*\(/i, /\s+NOT\s+IN\s/i];
/** 已按仓库约定拉平存储类的标志。 */
const CAST_WRAP = /\bCAST\s*\(/i;

type Violation = { file: string; line: number; text: string };

/**
 * 单行判定（抽成纯函数，方便下面的自检用例直接喂字符串）。
 *
 * 规则刻意**保守（宁可误报，不可漏报）**：只看"这一行里有 JSON 路径字面量 + 有相等比较 + 没有 CAST"，
 * 不区分 SQL 模板与 JS 赋值。因此 `const f = () => row["$.k"] === "a";` 这类纯 JS 行也会命中——
 * 仓库现状为 0 条（全仓扫描见下面的用例）；若将来前端真出现合法的 JSON 路径字符串行，
 * 走 ALLOWLIST 并写明理由，**不允许**为了变绿而放宽整条规则。
 */
function lineIsViolation(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  // 注释行整行跳过（`//` 行注释、`/*` 块注释开头、JSDoc 续行 `*`）。
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false;
  if (!JSON_PATH_LITERAL.test(t)) return false;
  if (CAST_WRAP.test(t)) return false;
  return EQUALITY_COMPARISON.some((re) => re.test(t));
}

/** 扫一份源码文本（相对路径只用于报告）。 */
function scanSource(relPath: string, source: string): Violation[] {
  const out: Violation[] = [];
  source.split(/\r?\n/).forEach((line, i) => {
    if (lineIsViolation(line)) out.push({ file: relPath, line: i + 1, text: line.trim() });
  });
  return out;
}

function* iterTsFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 无权限/竞态删除：跳过该目录，不让守卫因 IO 而假绿
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* iterTsFiles(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(e.name)) continue;
    if (TEST_FILE.test(e.name)) continue;
    yield full;
  }
}

/** 扫一个目录树，返回全部命中 + 实际扫过的文件数（后者用来证明"不是空转"）。 */
function scanTree(root: string): { violations: Violation[]; scannedFiles: number } {
  const violations: Violation[] = [];
  let scannedFiles = 0;
  for (const file of iterTsFiles(root)) {
    scannedFiles += 1;
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    violations.push(...scanSource(path.relative(root, file), source));
  }
  return { violations, scannedFiles };
}

/**
 * 棘轮允许清单：**必须为空**。
 * 任何条目都要写理由，且只允许"非 SQL 上下文"这类误报（不是"暂时没修"）。
 */
const ALLOWLIST: readonly string[] = [];

/** 故意写错的样本：包含 t14/t15/t16 **修复前**从仓库里抄出来的原句。守卫必须逐条判红。 */
const BAD_EXAMPLES: Array<{ title: string; line: string }> = [
  {
    title: "t16 修复前的 api/boot.ts:368 原句（json_extract 裸比 String(id)）",
    line: `sql\`json_extract(\${ingestionItems.metadata}, '$.uploadedFileId') = \${String(id)}\`,`,
  },
  {
    title: "t15 修复前的孪生写法（->> 裸比 String(id)）",
    line: `sql\`\${ingestionItems.metadata}->>'$.uploadedFileId' = \${String(input.uploadedFileId)}\`,`,
  },
  {
    title: "t14 修复前的去重写法（->> 裸比 dataSourceId）",
    line: `sql\`\${ingestionItems.metadata}->>'$.dataSourceId' = \${String(ds.id)}\`,`,
  },
  {
    title: "手写 SQL 字符串里的裸比较（2026-09-22 事故同款）",
    line: `const q = "SELECT id FROM t WHERE json_extract(metadata, '$.documentId') = '1855'";`,
  },
  { title: "!= 形态", line: `sql\`json_extract(\${n.metadata}, '$.documentId') != \${String(id)}\`` },
  { title: "<> 形态", line: `sql\`json_extract(\${n.metadata}, '$.documentId') <> \${String(id)}\`` },
  { title: "IN 形态", line: `sql\`json_extract(\${n.metadata}, '$.documentId') IN (\${ids.join(",")})\`` },
  {
    // 这是规则**故意过度保守**的那一面（纯 JS 行也被拦下）：钉成用例，免得后来人以为它只查 SQL。
    // 仓库现状 0 条这样的行；真出现合法前端用法时按 ALLOWLIST 放行并写理由。
    title: "已知过度保守面：JS 赋值行内含 JSON 路径字面量",
    line: `const f = () => row["$.kind"] === "a";`,
  },
];

const GOOD_EXAMPLES: Array<{ title: string; line: string }> = [
  {
    title: "仓库约定口径 A：CAST(->> AS TEXT)",
    line: `sql\`CAST(\${ingestionItems.metadata}->>'$.uploadedFileId' AS TEXT) = \${String(input.uploadedFileId)}\`,`,
  },
  {
    title: "仓库约定口径 B：CAST(json_extract AS TEXT)",
    line: `sql\`CAST(json_extract(\${ingestionItems.metadata}, '$.uploadedFileId') AS TEXT) = \${String(id)}\`,`,
  },
  {
    title: "仓库约定口径 C：CAST(json_extract AS INTEGER)（document-node-match.ts:20 原句）",
    line: `return sql\`CAST(json_extract(\${knowledgeNodes.metadata}, '$.documentId') AS INTEGER) = \${id}\`;`,
  },
  {
    title: "巡检口径：CAST ... NOT IN（index-health.ts:80）",
    line: `AND CAST(json_extract(metadata, '$.documentId') AS INTEGER) NOT IN (SELECT id FROM kb_documents)`,
  },
  {
    title: "IS NOT NULL 不受存储类影响（index-health.ts:88）",
    line: `WHERE json_extract(metadataJson, '$.embeddingModel') IS NOT NULL`,
  },
  {
    title: "纯投影 + GROUP BY，无相等比较（index-health.ts:86）",
    line: `SELECT json_extract(metadataJson, '$.embeddingModel') AS model, COUNT(*) AS c`,
  },
  {
    title: "同向 CAST：TEXT 列比 CAST 成 TEXT（index-health.ts:59）",
    line: `SELECT 1 FROM vec_chunk_meta vm WHERE vm.documentId = CAST(dc.documentId AS TEXT) AND vm.chunkIndex = dc.chunkIndex`,
  },
  {
    title: "注释里的反例不得算命中（// 行）",
    line: `          // \`metadata->>'$.dataSourceId' = '1'\` 对 {"dataSourceId":1} 恒为假 —— 于是整条去重`,
  },
  {
    title: "注释里的反例不得算命中（JSDoc 续行 *）",
    line: `   * 统一口径：\`CAST(json_extract(metadata,'$.documentId') AS INTEGER) = <id>\`，`,
  },
  {
    title: "只做判空（IS NOT NULL）不参与相等比较的 drizzle 写法",
    line: `sql\`json_extract(\${ingestionItems.metadata}, '$.uploadedFileId') IS NOT NULL\`,`,
  },
];

let tmpRoot: string | null = null;
afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("json-sql 棘轮守卫：自检（证明它不是永远为真）", () => {
  it("自检 1｜坏写法逐条判红（含 t14/t15/t16 修复前的三句原话）", () => {
    expect(BAD_EXAMPLES.length).toBeGreaterThanOrEqual(7);
    for (const ex of BAD_EXAMPLES) {
      const hits = scanSource("synthetic/bad-sample.ts", ex.line);
      expect(hits, `应当判红却放行：${ex.title}`).toHaveLength(1);
      expect(hits[0]?.line).toBe(1);
      expect(hits[0]?.text).toBe(ex.line.trim());
    }
  });

  it("自检 2｜正确写法逐条放行（仓库现存全部 CAST 口径 + 注释反例 + 判空写法）", () => {
    for (const ex of GOOD_EXAMPLES) {
      expect(scanSource("synthetic/good-sample.ts", ex.line), `误报：${ex.title}`).toEqual([]);
    }
  });

  it("自检 3｜真在文件系统上扫描：坏文件报红（带行号+内容），好文件/测试文件/注释/scripts 全跳过", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "json-sql-guard-"));
    const write = (rel: string, text: string) => {
      const full = path.join(tmpRoot as string, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, "utf8");
    };

    write("app/bad.ts", `const a = 1;\n${BAD_EXAMPLES[0]?.line ?? ""}\n`);
    write("app/good.ts", `const a = 1;\n${GOOD_EXAMPLES[1]?.line ?? ""}\n`);
    // 测试文件与 scripts/、node_modules 里放同样的坏句：必须被跳过（否则自检用例自己会被自己判红）
    write("app/bad.spec.ts", BAD_EXAMPLES[0]?.line ?? "");
    write("scripts/legacy.ts", BAD_EXAMPLES[0]?.line ?? "");
    write("node_modules/victim.ts", BAD_EXAMPLES[0]?.line ?? "");
    write("app/comment-only.ts", `// ${BAD_EXAMPLES[0]?.line ?? ""}\n`);
    // 含 JSON 路径字面量、但该行没有任何相等比较（比较在上一行结尾）：不该算命中
    write("app/paths-only.ts", "const paths: string[] =\n  ['$.a', '$.b'];\n");

    const { violations, scannedFiles } = scanTree(tmpRoot);
    // 4 = bad.ts + good.ts + comment-only.ts + paths-only.ts；被跳过的三个文件不在其中
    expect(scannedFiles).toBe(4);
    expect(violations.map((v) => v.file)).toEqual([path.join("app", "bad.ts")]);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.text).toContain("json_extract");
  });

  it("自检 4｜行号与内容真的来自被扫文件（不是硬编码）", () => {
    const src = ["// 注释", GOOD_EXAMPLES[1]?.line ?? "", "", BAD_EXAMPLES[3]?.line ?? ""].join("\n");
    const hits = scanSource("x/y.ts", src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(4);
    expect(hits[0]?.text).toBe(BAD_EXAMPLES[3]?.line ?? "");
  });
});

describe("json-sql 棘轮守卫：全仓现状", () => {
  it("仓库根可解析、扫描覆盖到真实代码文件（非空转）", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "api", "boot.ts"))).toBe(true);
    const { scannedFiles } = scanTree(REPO_ROOT);
    // api/ 下单文件测试就有 60+，全仓 .ts/.tsx 远多于此；低于 100 说明扫描根本没跑起来
    expect(scannedFiles).toBeGreaterThan(100);
  });

  it("没有裸的 JSON 相等比较；允许清单必须保持为空", () => {
    const { violations } = scanTree(REPO_ROOT);
    const hits = violations
      .filter((v) => !ALLOWLIST.includes(v.file))
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join("\n");

    expect(
      violations,
      `发现 ${violations.length} 处"JSON 路径取值裸参与相等比较"（SQLite 存储类语义下恒不命中，` +
        `见 api/lib/document-node-match.ts 的 2026-09-22 事故记录）。修法：包成 CAST(... AS TEXT) 或` +
        ` CAST(... AS INTEGER)，两侧统一到同一存储类再比。\n${hits || "(无命中)"}`,
    ).toEqual([]);
    expect(ALLOWLIST).toEqual([]);
  });

  it("已修好的三处必须保持 CAST 口径（防止被'顺手优化'回去）", () => {
    const pinned: Array<[string, RegExp]> = [
      ["api/boot.ts", /CAST\(json_extract\(\$\{ingestionItems\.metadata\},\s*'\$\.uploadedFileId'\)\s*AS TEXT\)/],
      ["api/ingestion-router.ts", /CAST\(\$\{ingestionItems\.metadata\}->>'\$\.uploadedFileId' AS TEXT\)/],
      ["api/datasource-router.ts", /CAST\(\$\{ingestionItems\.metadata\}->>'\$\.dataSourceId' AS TEXT\)/],
      ["api/lib/document-node-match.ts", /CAST\(json_extract\(\$\{knowledgeNodes\.metadata\},\s*'\$\.documentId'\)\s*AS INTEGER\)/],
    ];
    for (const [rel, re] of pinned) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(source, `${rel} 丢了 CAST 口径`).toMatch(re);
    }
  });
});
