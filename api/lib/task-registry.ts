/**
 * 长任务统一句柄注册表（P0-4）
 *
 * 解决的问题：备份/重建索引这类长任务此前没有可轮询的句柄——调用方只能干等，
 * 或者靠业务表里猜哪一行是自己刚触发的那次运行。
 *
 * 设计口径：
 * - 注册表只保存「句柄 → 任务身份/进度」的映射，业务真相仍在业务表（backup_jobs）或
 *   索引器进度（getReindexProgress）里；task_get 时以业务真相为准并同步回注册表。
 * - 取消是「请求 + 确认」两段式：requestCancel 只置位并返回 accepted，
 *   执行方轮询 isCancelRequested 决定何时收手，并以 finishTask(id, "cancelled") 确认。
 *   这样绝不会出现「报了取消成功、实际还在跑」的假象。
 * - 进程内存储（与既有 getReindexProgress 同层），容量有上限，优先淘汰最旧的终态任务。
 */

export type TaskKind = "backup" | "reindex";
export type TaskStatus = "running" | "completed" | "failed" | "cancelled";
export type TerminalStatus = Exclude<TaskStatus, "running">;

export interface TaskRecord {
  readonly taskId: string;
  readonly kind: TaskKind;
  readonly refId?: number;
  readonly status: TaskStatus;
  readonly progress: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly meta?: Record<string, unknown>;
}

export interface CreateTaskInput {
  readonly kind: TaskKind;
  readonly refId?: number;
  readonly meta?: Record<string, unknown>;
}

export interface CancelOutcome {
  readonly accepted: boolean;
  readonly task: TaskRecord;
  readonly reason?: string;
}

export interface ListTasksFilter {
  readonly kind?: TaskKind;
  readonly limit?: number;
}

/** 注册表容量上限：超出后优先淘汰最旧的终态任务 */
export const MAX_TASKS = 200;

interface TaskEntry {
  record: TaskRecord;
  cancelRequested: boolean;
}

/** Map 保持插入顺序 → 天然是「创建时间倒序」的淘汰顺序 */
const tasks = new Map<string, TaskEntry>();
let seq = 0;

function nowIso(): string {
  return new Date().toISOString();
}

/** meta 的值约定为标量（浅拷即隔离）；塞嵌套对象会破坏「返回副本」契约（审查 Q9） */
function clone(record: TaskRecord): TaskRecord {
  return { ...record, ...(record.meta ? { meta: { ...record.meta } } : {}) };
}

function isTerminal(status: TaskStatus): status is TerminalStatus {
  return status !== "running";
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * 容量控制：**只淘汰终态任务**，运行中的句柄永不淘汰。
 * 理由：运行中任务被淘汰等于调用方失去轮询/取消能力（比容量软上限严重得多）；
 * 并发长任务在现实中屈指可数，因此允许极少数情况下暂时超出 MAX_TASKS。
 */
function evictIfNeeded(): void {
  if (tasks.size <= MAX_TASKS) return;
  for (const [id, entry] of tasks) {
    if (tasks.size <= MAX_TASKS) return;
    if (isTerminal(entry.record.status)) tasks.delete(id);
  }
}

export function createTask(input: CreateTaskInput): TaskRecord {
  seq += 1;
  const taskId = `tsk_${input.kind}_${Date.now().toString(36)}${seq.toString(36).padStart(3, "0")}`;
  const record: TaskRecord = {
    taskId,
    kind: input.kind,
    ...(input.refId !== undefined ? { refId: input.refId } : {}),
    status: "running",
    progress: 0,
    startedAt: nowIso(),
    ...(input.meta ? { meta: { ...input.meta } } : {}),
  };
  tasks.set(taskId, { record, cancelRequested: false });
  evictIfNeeded();
  return clone(record);
}

export function getTask(taskId: string): TaskRecord | undefined {
  const entry = tasks.get(taskId);
  return entry ? clone(entry.record) : undefined;
}

export function listTasks(filter: ListTasksFilter = {}): TaskRecord[] {
  const limit = filter.limit === undefined ? undefined : Math.max(0, Math.floor(filter.limit));
  const all = [...tasks.values()].reverse()
    .map((e) => e.record)
    .filter((r) => (filter.kind ? r.kind === filter.kind : true));
  const limited = limit === undefined ? all : all.slice(0, limit);
  return limited.map(clone);
}

export function updateTaskProgress(
  taskId: string,
  progress: number,
  meta?: Record<string, unknown>,
): TaskRecord | undefined {
  const entry = tasks.get(taskId);
  if (!entry) return undefined;
  // 终态任务不再改写：完成后的进度/元数据是最终事实
  if (isTerminal(entry.record.status)) return clone(entry.record);
  entry.record = {
    ...entry.record,
    progress: clampProgress(progress),
    ...(meta ? { meta: { ...entry.record.meta, ...meta } } : {}),
  };
  return clone(entry.record);
}

export function finishTask(
  taskId: string,
  status: TerminalStatus,
  options: { readonly error?: string; readonly progress?: number; readonly meta?: Record<string, unknown> } = {},
): TaskRecord | undefined {
  const entry = tasks.get(taskId);
  if (!entry) return undefined;
  if (isTerminal(entry.record.status)) return clone(entry.record);
  entry.record = {
    ...entry.record,
    status,
    progress: options.progress !== undefined ? clampProgress(options.progress) : entry.record.progress,
    finishedAt: nowIso(),
    ...(options.error ? { error: options.error } : {}),
    ...(options.meta ? { meta: { ...entry.record.meta, ...options.meta } } : {}),
  };
  // 终态即确认，取消信号复位
  entry.cancelRequested = false;
  return clone(entry.record);
}

export function requestCancel(taskId: string): CancelOutcome | undefined {
  const entry = tasks.get(taskId);
  if (!entry) return undefined;
  if (isTerminal(entry.record.status)) {
    return { accepted: false, task: clone(entry.record), reason: `任务已 ${entry.record.status}，无需取消` };
  }
  entry.cancelRequested = true;
  return { accepted: true, task: clone(entry.record) };
}

export function isCancelRequested(taskId: string): boolean {
  return tasks.get(taskId)?.cancelRequested === true;
}

/** 仅测试用：清空注册表 */
export function resetTaskRegistryForTest(): void {
  tasks.clear();
  seq = 0;
}
