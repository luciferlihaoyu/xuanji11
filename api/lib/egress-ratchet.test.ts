/**
 * 出网登记棘轮（2026-10-01，PLAN-出网安全收尾三件事 §2）。
 *
 * 双向对账：
 *  ① 实际有、清单无 → 未登记的新出网点 → 红（要求改走 safeFetch 或带理由登记）；
 *  ② 清单有、实际无（或数目不符）→ 清单必须收缩/修正 → 红（清单只减不涨）。
 *
 * 已知局限（基线口径，写明以防误信）：行级正则只抓**直呼** fetch(，
 * 不抓 `const f = fetch; f(…)`、`globalThis.fetch(…)`、跨行拆写的形态。
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FETCH_SITES } from "./egress-allowlist";

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 自身实现文件不参与扫描（本文件是测试、allowlist 无调用、safe-fetch/egress 是门禁本体）
const EXCLUDED = new Set(["lib/safe-fetch.ts", "lib/egress.ts", "lib/egress-allowlist.ts"]);

function listApiTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(API_DIR, full).split(path.sep).join("/");
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === "__fixtures__" || name === "node_modules") continue;
      listApiTsFiles(full, out);
    } else if (rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !EXCLUDED.has(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/** 与扫描口径一致：直呼 fetch(（排除 .fetch( / myfetch( / prefetch( 等形态） */
const FETCH_CALL = /(?<![\w.$])fetch\s*\(/;

function countFetchCalls(file: string): number {
  let n = 0;
  for (const line of fs.readFileSync(path.join(API_DIR, file), "utf-8").split("\n")) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (FETCH_CALL.test(line)) n += 1;
  }
  return n;
}

function scanActual(): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of listApiTsFiles(API_DIR)) {
    const n = countFetchCalls(f);
    if (n > 0) m.set(f, n);
  }
  return m;
}

describe("出网登记棘轮", () => {
  it("每个登记条目都必须有理由与合法状态", () => {
    for (const e of FETCH_SITES) {
      expect(
        e.note.trim().length,
        `api/${e.file} 的 note 不能为空 —— 登记必须给理由`,
      ).toBeGreaterThan(0);
      expect(["ok-admin", "ok-internal", "to-migrate"], `api/${e.file} 的 status 非法`).toContain(e.status);
    }
  });

  it("实际出网点与清单完全一致（新增要登记，减少要收缩——只减不涨）", () => {
    const actual = scanActual();

    // ① 实际有、清单无 → 未登记的新出网点
    for (const [file, count] of actual) {
      const entry = FETCH_SITES.find((e) => e.file === file);
      expect(
        entry,
        `发现未登记的出网点：api/${file}（${count} 处）。` +
          `请改走 lib/safe-fetch 的 safeFetch（用户可控 URL 用默认 scope，管理员配置目标传 scope:"admin"），` +
          `或带理由登记到 lib/egress-allowlist.ts`,
      ).toBeDefined();
    }

    // ② 清单有、实际无/数不符 → 清单必须收缩或修正
    for (const e of FETCH_SITES) {
      const actualCount = actual.get(e.file) ?? 0;
      expect(
        actualCount,
        `api/${e.file} 清单记 ${e.count} 处，实际 ${actualCount} 处 —— 出网点已变化，请同步收缩/修正清单（只减不涨）`,
      ).toBe(e.count);
    }
  });
});
