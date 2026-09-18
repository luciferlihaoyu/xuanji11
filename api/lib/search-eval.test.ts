import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  // env.ts 启动校验需要；测试进程提供桩值（与 backup-scheduler.test.ts 同模式）
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-characters-long!!";
});

const { evalCasesTable } = vi.hoisted(() => ({ evalCasesTable: { __isEvalCases: true } }));

vi.mock("@db/schema", async () => {
  const actual = await vi.importActual<typeof import("@db/schema")>("@db/schema");
  return { ...actual, kbEvalCases: evalCasesTable };
});

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));

const searchMock = vi.hoisted(() => ({ executeHybridSearch: vi.fn() }));
vi.mock("./hybrid-search", () => searchMock);

import { computeEvalMetrics, evaluateSingleCase, runEval } from "./search-eval";
import { getDb } from "../queries/connection";

function docResult(id: number | string) {
  return { type: "document", id: String(id), title: `doc${id}`, snippet: "s", score: 0.1, sources: [], tags: [], folderId: null, reasons: [], evidence: [] };
}

function fakeDbWithCases(rows: Array<{ id: number; query: string; expectedDocIds: string; note: string | null }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(async () => rows),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("evaluateSingleCase（单用例打分）", () => {
  it("部分命中：recall=命中/期望，rr=首个命中名次倒数", () => {
    const r = evaluateSingleCase(1, "q", [11, 33], [11, 12]);
    expect(r.recallAtK).toBe(0.5);
    expect(r.reciprocalRank).toBe(1);
  });

  it("全命中", () => {
    const r = evaluateSingleCase(2, "q", [12, 11], [11, 12]);
    expect(r.recallAtK).toBe(1);
    expect(r.reciprocalRank).toBe(1);
  });

  it("无命中：recall=0 rr=0；命中在第 2 位 rr=0.5", () => {
    expect(evaluateSingleCase(3, "q", [99], [11, 12]).recallAtK).toBe(0);
    expect(evaluateSingleCase(4, "q", [99], [11, 12]).reciprocalRank).toBe(0);
    expect(evaluateSingleCase(5, "q", [12], [11, 12]).reciprocalRank).toBe(0.5);
  });

  it("期望集合去重：重复期望不稀释 recall", () => {
    expect(evaluateSingleCase(6, "q", [11, 11], [11]).recallAtK).toBe(1);
  });
});

describe("computeEvalMetrics（汇总）", () => {
  it("空集返回全 0", () => {
    expect(computeEvalMetrics([])).toEqual({ caseCount: 0, meanRecallAtK: 0, mrr: 0, failedCount: 0 });
  });

  it("三用例手算：meanRecall=(0.5+0+1)/3=0.5，mrr=(1+0+0.5)/3=0.5", () => {
    const a = evaluateSingleCase(1, "q", [11, 33], [11, 12]);
    const b = evaluateSingleCase(2, "q", [99], [11, 12]);
    const c = evaluateSingleCase(3, "q", [12], [11, 12]);
    const m = computeEvalMetrics([a, b, c]);
    expect(m.caseCount).toBe(3);
    expect(m.meanRecallAtK).toBe(0.5);
    expect(m.mrr).toBe(0.5);
  });
});

describe("runEval 容错（单条失败不毁全盘报告）", () => {
  it("某条检索抛错 → 该条标 error 且不计入指标，其余照常出分", async () => {
    vi.mocked(getDb).mockReturnValue(fakeDbWithCases([
      { id: 1, query: "会炸的查询", expectedDocIds: "[11]", note: null },
      { id: 2, query: "正常查询", expectedDocIds: "[22]", note: null },
    ]) as never);
    searchMock.executeHybridSearch
      .mockRejectedValueOnce(new Error("embedding 服务挂了"))
      .mockResolvedValueOnce({
        results: [docResult(22)],
        facets: { types: {}, tags: {}, folders: {} },
        metadata: { mode: "hybrid", query: "正常查询", limit: 5, total: 1, keywordResults: 1, vectorResults: 1, durationMs: 1, cached: false },
      });

    const r = await runEval();
    expect(r.results).toHaveLength(2);
    const failed = r.results.find((x) => x.caseId === 1);
    const okCase = r.results.find((x) => x.caseId === 2);
    expect(failed?.error).toContain("embedding");
    expect(okCase?.error).toBeUndefined();
    expect(okCase?.recallAtK).toBe(1);
    // 指标只统计成功用例（失败项不污染 recall/MRR），另报 failedCount
    expect(r.metrics.caseCount).toBe(1);
    expect(r.metrics.failedCount).toBe(1);
    expect(r.metrics.meanRecallAtK).toBe(1);
    expect(r.metrics.mrr).toBe(1);
  });
});

describe("runEval（读库+检索+打分）", () => {
  it("默认参数：hybrid / rerank=false / limit=5；只统计 document 结果；非数字 id 被剔除", async () => {
    vi.mocked(getDb).mockReturnValue(fakeDbWithCases([
      { id: 7, query: "备份方案", expectedDocIds: "[11]", note: null },
    ]) as never);
    searchMock.executeHybridSearch.mockResolvedValue({
      results: [docResult(11), docResult("abc"), { type: "node", id: "11", title: "n", snippet: "", score: 0, sources: [], tags: [], folderId: null, reasons: [], evidence: [] }],
      facets: { types: {}, tags: {}, folders: {} },
      metadata: { mode: "hybrid", query: "备份方案", limit: 5, total: 3, keywordResults: 2, vectorResults: 1, durationMs: 1, cached: false },
    });

    const r = await runEval();
    expect(searchMock.executeHybridSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "备份方案", mode: "hybrid", limit: 5, rerank: false }),
    );
    expect(r.results[0].hitDocIds).toEqual([11]);
    expect(r.results[0].recallAtK).toBe(1);
    expect(r.metrics.caseCount).toBe(1);
    expect(typeof r.durationMs).toBe("number");
  });

  it("opts 透传：topK→limit、rerank=true", async () => {
    vi.mocked(getDb).mockReturnValue(fakeDbWithCases([
      { id: 8, query: "x", expectedDocIds: "[1]", note: null },
    ]) as never);
    searchMock.executeHybridSearch.mockResolvedValue({
      results: [],
      facets: { types: {}, tags: {}, folders: {} },
      metadata: { mode: "vector", query: "x", limit: 9, total: 0, keywordResults: 0, vectorResults: 0, durationMs: 1, cached: false },
    });
    await runEval({ mode: "vector", rerank: true, topK: 9 });
    expect(searchMock.executeHybridSearch).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "vector", rerank: true, limit: 9 }),
    );
  });

  it("expectedDocIds 非法 JSON 或非数组按空处理，不抛错", async () => {
    vi.mocked(getDb).mockReturnValue(fakeDbWithCases([
      { id: 9, query: "坏数据", expectedDocIds: "not-json", note: null },
    ]) as never);
    searchMock.executeHybridSearch.mockResolvedValue({
      results: [docResult(1)],
      facets: { types: {}, tags: {}, folders: {} },
      metadata: { mode: "hybrid", query: "坏数据", limit: 5, total: 1, keywordResults: 1, vectorResults: 0, durationMs: 1, cached: false },
    });
    const r = await runEval();
    expect(r.results[0].recallAtK).toBe(0);
    expect(r.metrics.meanRecallAtK).toBe(0);
  });
});
