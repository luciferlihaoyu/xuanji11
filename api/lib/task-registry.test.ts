import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TASKS,
  createTask,
  finishTask,
  getTask,
  isCancelRequested,
  listTasks,
  resetTaskRegistryForTest,
  updateTaskProgress,
  requestCancel,
} from "./task-registry";

describe("task registry（长任务统一句柄）", () => {
  beforeEach(() => resetTaskRegistryForTest());

  it("createTask 返回带 tsk_ 前缀的唯一 id，初值为 running/0", () => {
    const a = createTask({ kind: "backup", refId: 7 });
    const b = createTask({ kind: "backup", refId: 8 });
    expect(a.taskId).toMatch(/^tsk_/);
    expect(a.taskId).not.toBe(b.taskId);
    expect(a).toMatchObject({ kind: "backup", refId: 7, status: "running", progress: 0 });
    expect(typeof a.startedAt).toBe("string");
    expect(Number.isNaN(Date.parse(a.startedAt))).toBe(false);
    expect(a.finishedAt).toBeUndefined();
    expect(isCancelRequested(a.taskId)).toBe(false);
  });

  it("getTask 对未知 id 返回 undefined", () => {
    expect(getTask("tsk_nope")).toBeUndefined();
  });

  it("返回的是副本：外部改动不影响内部状态", () => {
    const t = createTask({ kind: "backup" });
    (t as { progress: number }).progress = 99;
    expect(getTask(t.taskId)?.progress).toBe(0);
  });

  it("updateTaskProgress 更新进度与 meta，不改变状态", () => {
    const t = createTask({ kind: "backup", refId: 3 });
    const updated = updateTaskProgress(t.taskId, 42, { filesDone: 4 });
    expect(updated).toMatchObject({ status: "running", progress: 42, meta: { filesDone: 4 } });
    expect(getTask(t.taskId)?.meta).toEqual({ filesDone: 4 });
  });

  it("updateTaskProgress 对未知 id 返回 undefined；进度被夹到 0..100", () => {
    expect(updateTaskProgress("tsk_nope", 10)).toBeUndefined();
    const t = createTask({ kind: "reindex" });
    expect(updateTaskProgress(t.taskId, 999)?.progress).toBe(100);
    expect(updateTaskProgress(t.taskId, -5)?.progress).toBe(0);
  });

  it("finishTask 落到终态并记录 finishedAt / error", () => {
    const t = createTask({ kind: "backup", refId: 11 });
    const done = finishTask(t.taskId, "completed", { progress: 100 });
    expect(done).toMatchObject({ status: "completed", progress: 100 });
    expect(done?.finishedAt && Number.isNaN(Date.parse(done.finishedAt))).toBe(false);

    const t2 = createTask({ kind: "backup" });
    expect(finishTask(t2.taskId, "failed", { error: "boom" })).toMatchObject({ status: "failed", error: "boom" });
  });

  it("终态任务不可被再次改写（幂等，不覆盖首次结果）", () => {
    const t = createTask({ kind: "backup" });
    finishTask(t.taskId, "completed", { progress: 100 });
    const again = finishTask(t.taskId, "failed", { error: "late" });
    expect(again).toMatchObject({ status: "completed" });
    expect(again?.error).toBeUndefined();
    expect(updateTaskProgress(t.taskId, 10)?.progress).toBe(100);
  });

  it("finishTask 对未知 id 返回 undefined", () => {
    expect(finishTask("tsk_nope", "completed")).toBeUndefined();
  });

  it("requestCancel 对运行中任务被接受，但状态仍 running（等执行方确认）", () => {
    const t = createTask({ kind: "reindex" });
    const r = requestCancel(t.taskId);
    expect(r?.accepted).toBe(true);
    expect(r?.task.status).toBe("running");
    expect(isCancelRequested(t.taskId)).toBe(true);
  });

  it("requestCancel 对已终结或未知任务不被接受，并给出原因", () => {
    const t = createTask({ kind: "backup" });
    finishTask(t.taskId, "completed", { progress: 100 });
    const r = requestCancel(t.taskId);
    expect(r?.accepted).toBe(false);
    expect(r?.reason).toContain("completed");
    expect(requestCancel("tsk_nope")).toBeUndefined();
  });

  it("任务被取消终结后 cancelRequested 复位", () => {
    const t = createTask({ kind: "backup" });
    requestCancel(t.taskId);
    finishTask(t.taskId, "cancelled");
    expect(isCancelRequested(t.taskId)).toBe(false);
    expect(getTask(t.taskId)?.status).toBe("cancelled");
  });

  it("listTasks 按创建倒序、可按 kind 过滤、支持 limit", () => {
    const a = createTask({ kind: "backup", refId: 1 });
    const b = createTask({ kind: "reindex" });
    const c = createTask({ kind: "backup", refId: 2 });
    expect(listTasks().map((t) => t.taskId)).toEqual([c.taskId, b.taskId, a.taskId]);
    expect(listTasks({ kind: "backup" }).map((t) => t.taskId)).toEqual([c.taskId, a.taskId]);
    expect(listTasks({ limit: 1 }).map((t) => t.taskId)).toEqual([c.taskId]);
    expect(listTasks({ limit: 0 })).toEqual([]);
  });

  it("终态任务超过上限时淘汰最旧的（保持容量软上限）", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_TASKS + 10; i += 1) {
      const t = createTask({ kind: "backup", refId: i });
      finishTask(t.taskId, "completed", { progress: 100 });
      ids.push(t.taskId);
    }
    expect(getTask(ids[0] as string)).toBeUndefined();
    expect(listTasks().length).toBe(MAX_TASKS);
    expect(getTask(ids[ids.length - 1] as string)).toBeDefined();
  });

  it("运行中的任务永不被淘汰（淘汰只针对终态）", () => {
    const running = createTask({ kind: "reindex" });
    for (let i = 0; i < MAX_TASKS; i += 1) {
      const t = createTask({ kind: "backup", refId: i });
      finishTask(t.taskId, "completed", { progress: 100 });
    }
    // 运行中句柄仍在（调用方仍能 task_get / task_cancel）
    expect(getTask(running.taskId)).toBeDefined();
    expect(listTasks().length).toBeLessThanOrEqual(MAX_TASKS);
  });

  it("即便全部任务都在运行且超限，也不丢弃任何运行中句柄", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_TASKS + 5; i += 1) ids.push(createTask({ kind: "backup", refId: i }).taskId);
    expect(ids.every((id) => getTask(id) !== undefined)).toBe(true);
  });
});
