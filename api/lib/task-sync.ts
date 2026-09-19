/**
 * P0-4 任务终态判定单点（天演审查 Q2/Q7）
 *
 * 背景：同一份业务真相会被两类调用方读取——
 *  ① 执行方收口（备份 `.then`、回填 finally）：任务已结束，此刻必须落终态；
 *  ② 读时收口（task_get / task_cancel 前先对齐）：句柄还在，状态可能已经结束或悬空。
 * 两处各写一套映射必然漂移（审查实测：一处要求 failed>0 且 lastError、另一处只看 failed>0，
 * 同一事实两个终态；且悬空进度被判 completed/100 = 谎报成功）。
 * 这里把规则钉死为纯函数，两边共用；who-is-right 的口径：
 *  - 备份：一律以 backup_jobs 行为准（行是持久真相）
 *  - 回填：真相是进程内索引器进度，它**不跨重启**；拿不到运行痕迹时判 failed，绝不判 completed
 */
import type { TerminalStatus } from "./task-registry";

export interface ReindexOutcomeInput {
  readonly running: boolean;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly lastError?: string;
  /** **执行方确认**的取消（循环真的因取消而停下）——只有执行方拿得到 */
  readonly cancelled?: boolean;
  /** 只是**收到取消请求**（还没停）：读时收口用它推断，绝不能当成「已取消」 */
  readonly cancelRequested?: boolean;
  /** 本次运行的启动时间；缺失 = 本进程没有任何回填运行的痕迹 */
  readonly startedAt?: string;
}

/**
 * 判定结果做成**可辨识联合**：调用方一旦排除 running，剩下的就一定是可终结态。
 * 这样 finishTask(..., status) 在类型上就成立，不需要在收口处强转或防御性抛错。
 */
export interface TerminalOutcome {
  readonly status: TerminalStatus;
  readonly progress: number;
  readonly error?: string;
  readonly meta: Record<string, unknown>;
}

export interface RunningOutcome {
  readonly status: "running";
  readonly progress: number;
  readonly meta: Record<string, unknown>;
}

export type TaskOutcome = TerminalOutcome | RunningOutcome;

function pct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

// 传入 running:false（执行方已收手）时只可能是终态 → 重载让调用方不必再防御 running
export function decideReindexOutcome(p: ReindexOutcomeInput & { readonly running: false }): TerminalOutcome;
export function decideReindexOutcome(p: ReindexOutcomeInput): TaskOutcome;
export function decideReindexOutcome(p: ReindexOutcomeInput): TaskOutcome {
  const meta = { total: p.total, done: p.done, failed: p.failed };
  // ① 执行方确认的取消优先：人工取消不是故障，即使中途有文档失败也按 cancelled 记
  if (p.cancelled) return { status: "cancelled", progress: pct(p.done, p.total), meta };
  // ② 仍在跑：只报 running。**「收到取消请求」不等于「已取消」**——
  //    在线实测抓到的谎报就是这里：读时收口把请求当成既成事实，句柄已 cancelled 而循环还在跑
  if (p.running) return { status: "running", progress: pct(p.done, p.total), meta };
  // ③ 进度已丢失：本进程从未启动过回填（进程重启后 idle 归零）→ 无法确认结果，绝不谎报成功
  if (!p.startedAt && p.total === 0 && p.done === 0 && p.failed === 0) {
    return { status: "failed", progress: 0, error: "回填进度已丢失（进程可能重启），无法确认本次结果", meta };
  }
  // ④ 有失败即失败——**不附加 lastError 条件**，否则同一事实会因观察路径不同得出两个终态
  if (p.failed > 0) {
    return {
      status: "failed",
      progress: pct(p.done, p.total),
      error: p.lastError ?? `有 ${p.failed} 篇文档索引失败`,
      meta,
    };
  }
  // ⑤ 只有**跑满全部文档**才算完成（done>=total）：早停不能因为「没失败」就报成功
  if (p.done >= p.total) return { status: "completed", progress: 100, meta };
  // ⑥ 没跑完 + 有取消请求 → 推断为取消（执行方未留痕时的诚实推断，meta 里看得到 done/total）
  if (p.cancelRequested) return { status: "cancelled", progress: pct(p.done, p.total), meta };
  // ⑦ 没跑完又没取消请求 = 异常提前结束
  return {
    status: "failed",
    progress: pct(p.done, p.total),
    error: `回填提前结束：只处理了 ${p.done}/${p.total} 篇（无取消请求）`,
    meta,
  };
}

export interface BackupRowLike {
  readonly status: string;
  readonly progress?: number | null;
  readonly error?: string | null;
  readonly filesTotal?: number | null;
  readonly filesDone?: number | null;
  readonly filesFailed?: number | null;
}

export interface BackupOutcomeMeta { readonly filesTotal: number; readonly filesDone: number; readonly filesFailed: number }
export type BackupOutcome =
  | (TerminalOutcome & { readonly meta: BackupOutcomeMeta })
  | (RunningOutcome & { readonly meta: BackupOutcomeMeta });

/**
 * @param row     backup_jobs 行（undefined = 行已被删除，调用方保留原状态）
 * @param settled true = 执行方已收手（`.then` 之后），此刻行还停在 pending/running 属异常
 */
export function decideBackupOutcome(row: BackupRowLike | undefined, opts: { readonly settled: true }): (TerminalOutcome & { readonly meta: BackupOutcomeMeta }) | null;
export function decideBackupOutcome(row: BackupRowLike | undefined, opts: { readonly settled: boolean }): BackupOutcome | null;
export function decideBackupOutcome(row: BackupRowLike | undefined, opts: { readonly settled: boolean }): BackupOutcome | null {
  if (!row) return null;
  const meta = {
    filesTotal: row.filesTotal ?? 0,
    filesDone: row.filesDone ?? 0,
    filesFailed: row.filesFailed ?? 0,
  };
  if (row.status === "completed") return { status: "completed", progress: 100, meta };
  if (row.status === "cancelled") return { status: "cancelled", progress: row.progress ?? 0, meta };
  if (row.status === "failed" || row.status === "partial") {
    return { status: "failed", progress: row.progress ?? 0, error: row.error ?? `备份状态：${row.status}`, meta };
  }
  if (opts.settled) {
    return {
      status: "failed",
      progress: row.progress ?? 0,
      error: row.error ?? `备份运行未正常结束（进程可能重启）：${row.status}`,
      meta,
    };
  }
  return { status: "running", progress: row.progress ?? 0, meta };
}
