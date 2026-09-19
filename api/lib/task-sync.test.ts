/**
 * P0-4 后续修（天演审查 Q2/Q7）：任务终态判定必须**单点化**。
 * 之前「执行方收口」和「task_get 读时收口」各自解读同一份真相，口径不一致：
 *  - 执行方：failed>0 && lastError 才判 failed；读时：failed>0 就判 failed → 同一事实两种终态
 *  - 悬空/已丢失的回填进度（idle）读时被判 completed/100 → 谎报成功
 * 这里把规则钉死成纯函数，两边共用。
 */
import { describe, expect, it } from "vitest";
import { decideBackupOutcome, decideReindexOutcome } from "./task-sync";

describe("回填终态判定（decideReindexOutcome）", () => {
  it("取消优先：即使有失败也判 cancelled（人工取消不是故障）", () => {
    const r = decideReindexOutcome({ running: false, total: 4, done: 2, failed: 1, cancelled: true, startedAt: "t0" });
    expect(r.status).toBe("cancelled");
  });

  it("运行中：running，进度按 done/total", () => {
    const r = decideReindexOutcome({ running: true, total: 4, done: 1, failed: 0, startedAt: "t0" });
    expect(r.status).toBe("running");
    expect(r.progress).toBe(25);
  });

  it("有失败即 failed——**不附加 lastError 条件**（原读时/执行方不一致的根因）", () => {
    const noErr = decideReindexOutcome({ running: false, total: 4, done: 4, failed: 2, startedAt: "t0" });
    expect(noErr.status).toBe("failed");
    expect(noErr.error).toContain("2");
    const withErr = decideReindexOutcome({ running: false, total: 4, done: 4, failed: 2, lastError: "文档 3: 磁盘满", startedAt: "t0" });
    expect(withErr.status).toBe("failed");
    expect(withErr.error).toBe("文档 3: 磁盘满");
  });

  it("进度已丢失（从未启动过 / 进程重启后 idle）判 failed，**绝不谎报 completed**", () => {
    const r = decideReindexOutcome({ running: false, total: 0, done: 0, failed: 0 });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("重启");
  });

  it("真的跑过且无失败 → completed/100（0 文档也算正常完成，因为 startedAt 有值）", () => {
    const zero = decideReindexOutcome({ running: false, total: 0, done: 0, failed: 0, startedAt: "t0" });
    expect(zero.status).toBe("completed");
    const all = decideReindexOutcome({ running: false, total: 3, done: 3, failed: 0, startedAt: "t0" });
    expect(all.status).toBe("completed");
    expect(all.progress).toBe(100);
  });
});

describe("在线实测抓出的两处谎报（读时收口）", () => {
  it("只是**请求了**取消、运行还在跑 → 必须报 running（不能把请求当既成事实）", () => {
    const r = decideReindexOutcome({ running: true, total: 1523, done: 4, failed: 4, cancelRequested: true, startedAt: "t0" });
    expect(r.status).toBe("running");
  });

  it("运行已停 + 有取消请求 + 没跑完 → cancelled（这才是取消的既成事实）", () => {
    const r = decideReindexOutcome({ running: false, total: 1523, done: 4, failed: 0, cancelRequested: true, startedAt: "t0" });
    expect(r.status).toBe("cancelled");
  });

  it("运行已停 + 没跑完 + 没取消请求 → failed（提前结束是异常，绝不能报 completed）", () => {
    const r = decideReindexOutcome({ running: false, total: 1523, done: 4, failed: 0, startedAt: "t0" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("提前结束");
  });

  it("早停 + 有失败 + 有取消请求 → cancelled（与执行方「取消优先」对称，不留两个终态的窗口）", () => {
    const r = decideReindexOutcome({ running: false, total: 10, done: 3, failed: 2, cancelRequested: true, startedAt: "t0" });
    expect(r.status).toBe("cancelled");
    expect(r.meta).toEqual({ total: 10, done: 3, failed: 2 });
  });

  it("跑满全部文档才算 completed（done>=total），即使有取消请求也不谎报 cancelled", () => {
    const r = decideReindexOutcome({ running: false, total: 4, done: 4, failed: 0, cancelRequested: true, startedAt: "t0" });
    expect(r.status).toBe("completed");
  });

  it("执行方确认取消（cancelled=true）优先于一切：即使跑完了也按取消记", () => {
    const r = decideReindexOutcome({ running: false, total: 4, done: 4, failed: 2, cancelled: true, startedAt: "t0" });
    expect(r.status).toBe("cancelled");
  });
});

describe("备份终态判定（decideBackupOutcome）", () => {
  const base = { status: "running", progress: 40, filesTotal: 5, filesDone: 2, filesFailed: 0 };

  it("completed → completed/100，meta 计数兜底为 0（列可空）", () => {
    const r = decideBackupOutcome({ ...base, status: "completed", filesTotal: null, filesDone: null, filesFailed: null }, { settled: true })!;
    expect(r.status).toBe("completed");
    expect(r.progress).toBe(100);
    expect(r.meta).toEqual({ filesTotal: 0, filesDone: 0, filesFailed: 0 });
  });

  it("cancelled → cancelled，保留取消时刻真实进度（progress 列本就是百分比，不写 error）", () => {
    // 上传循环逐文件把行内 progress 推进到百分比；取消收尾不得把它覆盖回运行开始时的旧值
    const r = decideBackupOutcome({ ...base, status: "cancelled", progress: 20 }, { settled: true })!;
    expect(r.status).toBe("cancelled");
    expect(r.progress).toBe(20);
    expect(r.error).toBeUndefined();
  });

  it("failed / partial → failed，error 优先用行里的原因", () => {
    expect(decideBackupOutcome({ ...base, status: "failed", error: "磁盘满" }, { settled: true })?.error).toBe("磁盘满");
    expect(decideBackupOutcome({ ...base, status: "partial", error: null }, { settled: true })?.status).toBe("failed");
    expect(decideBackupOutcome({ ...base, status: "partial", error: null }, { settled: true })?.error).toContain("partial");
  });

  it("上下文决定 pending/running 的含义：执行方已收手 → failed；运行中 → running", () => {
    expect(decideBackupOutcome(base, { settled: false })?.status).toBe("running");
    expect(decideBackupOutcome(base, { settled: false })?.progress).toBe(40);
    const abnormal = decideBackupOutcome(base, { settled: true })!;
    expect(abnormal.status).toBe("failed");
    expect(abnormal.error).toContain("重启");
  });

  it("行不存在（undefined）→ 不改写终态（调用方保留原句柄状态）", () => {
    expect(decideBackupOutcome(undefined, { settled: true })).toBeNull();
  });
});
