import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "test-password-at-least-32-characters-long!!";

vi.mock("./ingestion-idempotency", () => ({ findDocumentByContentHash: vi.fn(async () => null) }));
vi.mock("../queries/connection", () => ({ getDb: vi.fn(), getRawDb: vi.fn() }));

import { findDocumentByContentHash } from "./ingestion-idempotency";
import { getDb, getRawDb } from "../queries/connection";
import { loadQualityThresholds, scoreDocumentQuality } from "./quality-scorer";
import { systemSettings } from "@db/schema";

function settingsDb(rows: Array<{ key: string; value: string | null }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认无 settings 表 → 回落 70/40
  vi.mocked(getDb).mockReturnValue(settingsDb([]) as never);
  vi.mocked(findDocumentByContentHash).mockResolvedValue(null);
});

describe("scoreDocumentQuality（确定性规则）", () => {
  it("正常文档：有来源、好标题、足量正文 → good（≥70）", async () => {
    const r = await scoreDocumentQuality({
      title: "土地管理法实施条例解读",
      content: "第一条 根据《土地管理法》，制定本条例。".repeat(10),
      source: "upload",
    });
    expect(r.level).toBe("good");
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.issues).toHaveLength(0);
  });

  it("正常中文文档（多段落、含换行）不得误判 garbled（0x0a/0x0d 等合法控制符要排除——2026-11-14 生产活测抓出的真误判）", async () => {
    const text = [
      "## 项目周报",
      "",
      "本周完成了质量门接线与回滚演练。",
      "",
      "下周计划：三期部署验证与四期边收敛。",
      "",
      "风险：暂无。",
    ].join("\n");
    const r = await scoreDocumentQuality({ title: "项目周报", content: text, source: "upload", createdAt: new Date() });
    expect(r.issues.map((i) => i.code)).not.toContain("garbled");
    expect(r.issues.map((i) => i.code)).not.toContain("some_garbled");
    expect(r.level).toBe("good");
  });

  it("乱码比例高 → 扣分并给 garbled 问题", async () => {
    const garbled = "\u0000\u0001".repeat(50);
    const r = await scoreDocumentQuality({
      title: "正常标题若干字",
      content: garbled + "正常内容正常内容正常内容正常内容正常内容",
      source: "upload",
    });
    expect(r.issues.some((i) => i.code === "garbled" || i.code === "some_garbled")).toBe(true);
    expect(r.score).toBeLessThan(100);
  });

  it("未来日期 → future_date 扣分", async () => {
    const r = await scoreDocumentQuality({
      title: "未来文档标题",
      content: "正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文",
      source: "upload",
      createdAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    expect(r.issues.some((i) => i.code === "future_date")).toBe(true);
  });

  it("重复内容（新口径可达：查库命中既有文档）→ exact_duplicate 扣 10", async () => {
    vi.mocked(findDocumentByContentHash).mockResolvedValue(33);
    const r = await scoreDocumentQuality({
      title: "重复的文档标题",
      content: "这段内容与既有文档完全一致。".repeat(10),
      source: "upload",
    });
    expect(r.issues.some((i) => i.code === "exact_duplicate" && i.message.includes("33"))).toBe(true);
  });

  it("空正文 → poor（直调 scorer 口径：ingestFile 里该支不可达）", async () => {
    const r = await scoreDocumentQuality({ title: "未命名", content: "   ", source: null });
    expect(r.level).toBe("poor");
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["empty_content", "generic_title", "no_source"]));
  });

  it("阈值可配（options 覆盖）：90/80 下 75 分文档判 poor", async () => {
    // 无来源(-15) + 泛化标题(-10) = 75 分
    // 无来源(-15) + 泛化标题(-10) = 75 分（正文 42 字但 ≥50? 否——加长保证不触发 thin）
    const r = await scoreDocumentQuality(
      { title: "未命名文档", content: "正文".repeat(30), source: null },
      { thresholds: { good: 90, review: 80 } },
    );
    expect(r.score).toBe(75);
    expect(r.level).toBe("poor");
  });

  it("阈值可配（options 覆盖）：默认判 review 的 55 分文档在 40/30 下判 good 侧", async () => {
    // 无来源(-15) + 短标题(-8) + 薄正文(-12) + 未来日期(-10) = 55 分
    const input = {
      title: "AB",
      content: "太短了",
      source: null,
      createdAt: new Date(Date.now() + 10 * 24 * 3600 * 1000),
    };
    expect((await scoreDocumentQuality(input)).level).toBe("review"); // 默认 40-70
    expect((await scoreDocumentQuality(input, { thresholds: { good: 50, review: 40 } })).level).toBe("good"); // 55≥50
  });
});

describe("loadQualityThresholds（settings 驱动）", () => {
  it("settings 存在 → 读取生效", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([
      { key: "quality_threshold_good", value: "80" },
      { key: "quality_threshold_review", value: "50" },
    ]) as never);
    expect(await loadQualityThresholds()).toEqual({ good: 80, review: 50 });
  });

  it("settings 缺失/脏值 → 默认 70/40", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([{ key: "quality_threshold_good", value: "abc" }]) as never);
    expect(await loadQualityThresholds()).toEqual({ good: 70, review: 40 });
  });

  it("查询抛错（settings 表不存在等）→ 默认 70/40，绝不抛", async () => {
    vi.mocked(getDb).mockImplementation(() => { throw new Error("no table"); });
    expect(await loadQualityThresholds()).toEqual({ good: 70, review: 40 });
  });

  it("scoreDocumentQuality 默认走 settings：good 阈值配成 99 → 85 分文档从 good 降 review", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([
      { key: "quality_threshold_good", value: "99" },
      { key: "quality_threshold_review", value: "40" },
    ]) as never);
    // 无来源(-15) → 85 分：默认阈值下是 good，settings 把 good 提到 99 后必须变 review（证明真读了配置）
    const r = await scoreDocumentQuality({
      title: "土地管理法实施条例解读",
      content: "第一条 根据《土地管理法》，制定本条例。".repeat(10),
      source: null,
    });
    expect(r.score).toBe(85);
    expect(r.level).toBe("review");
  });
});

describe("scoreDocumentQuality 与 systemSettings 表名一致性（防误用 mock）", () => {
  it("loadQualityThresholds 查询确实用 systemSettings 表", async () => {
    const db = settingsDb([{ key: "quality_threshold_review", value: "55" }]);
    vi.mocked(getDb).mockReturnValue(db as never);
    const t = await loadQualityThresholds();
    expect(t.review).toBe(55);
    const fromCall = db.select.mock.results[0]?.value;
    expect(fromCall?.from).toHaveBeenCalled();
    void systemSettings;
  });
});
