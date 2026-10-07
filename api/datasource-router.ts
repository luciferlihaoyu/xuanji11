import { z } from "zod";
import { eq, desc, and, sql, isNull, isNotNull, inArray } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { dataSources, ingestionJobs, ingestionItems, kbFolders, kbDocuments } from "@db/schema";
import { clean } from "./lib/clean";
import { env } from "./lib/env";
import { getConnector, type CloudConnector } from "./connectors";
import { ingestFile } from "./lib/ingestion";
import { logAudit } from "./lib/audit";

const DATA_SOURCE_TYPES = ["cloud_drive", "nas", "database", "api", "webhook", "rss", "notion", "obsidian"] as const;
type DataSourceType = (typeof DATA_SOURCE_TYPES)[number];

/** 已实现真实同步路由的数据源类型（cloud_drive 平台 115/aliyundrive + nas + rss 内联正文通路）。
 *  nas / rss 在 UI 里没有"平台"可选，靠 resolvePlatform 的「类型名即已注册连接器」兜底落到连接器；
 *  兜底不到（连接器未注册 / 平台名写错）时 sync 明确失败，绝不静默空转还报"同步完成"。 */
const IMPLEMENTED_DATA_SOURCE_TYPES: ReadonlySet<DataSourceType> = new Set<DataSourceType>(["cloud_drive", "nas", "rss"]);

function isImplementedDataSourceType(type: DataSourceType): boolean {
  return IMPLEMENTED_DATA_SOURCE_TYPES.has(type);
}

/** 归一并兜底连接平台：trim 后空串视为未设置（用 || 不用 ??，否则 "  " 会绕过兜底静默空转）。
 *  未显式指定平台时，若"类型名本身就是一个已注册连接器"（nas → "nas"、rss → "rss"），兜底为该类型名，
 *  让数据源真正走它的连接器；兜底不到就返回 undefined，由调用方明确失败——
 *  绝不许"一个条目都没同步却报 success 并盖 connected"（t11 问题 A）。
 *  cloud_drive 显式指定 115 / aliyundrive 时走 raw 分支，行为与既往完全一致。
 *  testConnection 与 sync 不得各自解析平台——统一经下面的 resolveConnectorFor 取用。
 *  此前只给 sync 加兜底，导致 rss 的 testConnection 零出网直写 "connected"（假成功回归）。 */
function resolvePlatform(type: DataSourceType, config: Record<string, unknown>): string | undefined {
  const raw = typeof config.platform === "string" ? config.platform.trim() : undefined;
  if (raw) return raw;
  return getConnector(type) ? type : undefined;
}

/** 连接器解析的统一口径（t12）：testConnection 与 sync **必须**都走这一个函数。
 *  此前 sync 有"解析不出连接器就明确失败"的闸门，testConnection 却没有——它在解析失败时
 *  落到"通用连接测试"分支，什么都不测就写 status:"connected" 并回"连接成功"，
 *  于是同一个 cloud_drive（config.platform 留空）源，sync 诚实报失败、testConnection 报成功，
 *  两个入口给出相反结论。把判定收进同一个函数，两条路径从结构上不可能再分叉。
 *  解析不出可用连接器时返回可读原因（点名平台，若确实没点名余地就说"未指定平台"），
 *  由调用方各自补上动作尾巴（"未执行同步" / "无法测试连接"）并**明确失败**——
 *  绝不允许"没做任何检查"就写 connected 或返回 success。 */
type ConnectorResolution =
  | { ok: true; platform: string; connector: CloudConnector }
  | { ok: false; reason: string };

/** 数据源内容在知识库里的归档根夹（所有源夹都挂在它下面）。 */
export const DATASOURCE_FOLDER_ROOT = "数据源";

/**
 * 确保「数据源/<源名>」文件夹存在，返回子夹 id（2026-10-01 用户诉求）。
 * 幂等：按 (parentId, name) 复用已有夹 —— 每轮同步调用都不会重复建夹。
 * ⚠️ 诚实边界：rename 数据源不会重命名已建好的夹（旧夹保留），本轮不做同步改名。
 */
async function ensureDatasourceFolder(
  db: ReturnType<typeof getDb>,
  name: string,
  createdBy: number | null,
): Promise<number> {
  const [root] = await db
    .select()
    .from(kbFolders)
    .where(and(isNull(kbFolders.parentId), eq(kbFolders.name, DATASOURCE_FOLDER_ROOT)))
    .limit(1);
  const rootId = root
    ? root.id
    : Number(
        (
          await db.insert(kbFolders).values({
            name: DATASOURCE_FOLDER_ROOT,
            parentId: null,
            icon: "database",
            sortOrder: 0,
            createdBy,
          })
        ).lastInsertRowid,
      );

  const [existing] = await db
    .select()
    .from(kbFolders)
    .where(and(eq(kbFolders.parentId, rootId), eq(kbFolders.name, name)))
    .limit(1);
  if (existing) return existing.id;

  const created = await db.insert(kbFolders).values({
    name,
    parentId: rootId,
    icon: "folder",
    sortOrder: 0,
    createdBy,
  });
  return Number(created.lastInsertRowid);
}

function resolveConnectorFor(type: DataSourceType, config: Record<string, unknown>): ConnectorResolution {
  const platform = resolvePlatform(type, config);
  if (!platform) return { ok: false, reason: "未指定平台且该类型无可用连接器" };
  const connector = getConnector(platform);
  if (!connector) return { ok: false, reason: `未找到平台 "${platform}" 对应的连接器` };
  return { ok: true, platform, connector };
}

/** 非手动同步间隔：调度器尚未实现，仅保存配置并诚实告知，不声称会定时同步 */
function syncIntervalNotice(config: Record<string, unknown> | null | undefined): string | undefined {
  const interval = config?.syncInterval;
  if (typeof interval === "string" && interval !== "" && interval !== "manual") {
    return "自动同步尚未启用，将仅保存配置";
  }
  return undefined;
}

/** 同步结果计数口径（t8 修复）——四个桶互斥，合计必等于本轮条目数：
 *    processed 真正成功入库的条目 | skipped 已同步过或连接器无正文而跳过
 *    ignored   非 file 条目（目录等），根本没进入入库流程 | failed 入库抛错
 *  旧口径把 skipped / ignored 也累加进 processed，于是
 *  `同步完成: 20 处理, 19 跳过, 1 失败` 里同一批条目被数了两遍，"处理"其实等于
 *  "跳过 + 成功"，唯一真正该成功的条目失败也被这句消息掩盖。标题词按判定结果分档：
 *  零失败=同步完成，有失败但也有成功=部分成功，一条都没落库=同步失败。
 *
 *  零条目另有口径（t10）：连接器压根没返回任何条目时，"成功 0, 跳过 0, 失败 0" 读起来
 *  像一次正常收工，而 testConnection 对同一地址会明说"当前没有任何条目，没有可同步的内容"
 *  —— 两个入口互相打脸。故 entryCount === 0 时换成点名"源没有可同步条目"的消息。
 *  注意这只改措辞：status 仍按"源可达且合法"判 connected（见 sync 内注释），
 *  但绝不在消息里把零条目说成有任何内容入库。 */
function syncSummaryMessage(entryCount: number, processed: number, skipped: number, ignored: number, failed: number): string {
  if (entryCount === 0) {
    return "同步完成: 源当前没有可同步的条目（0 条）—— 本轮没有任何内容入库；若这是订阅源，可能是它暂时没有发布内容";
  }
  const headline = failed === 0 ? "同步完成" : processed > 0 ? "部分成功" : "同步失败";
  const parts = [`成功 ${processed}`, `跳过 ${skipped}`];
  if (ignored > 0) parts.push(`忽略 ${ignored}`); // 只在真有其事时出现，避免日常噪音
  parts.push(`失败 ${failed}`);
  return `${headline}: ${parts.join(", ")}`;
}

export const datasourceRouter = createRouter({
  list: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(dataSources).orderBy(desc(dataSources.updatedAt));
  }),

  listByType: authedQuery
    .input(z.object({ type: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(dataSources)
        .where(eq(dataSources.type, input.type as DataSourceType))
        .orderBy(desc(dataSources.updatedAt));
    }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(dataSources).where(eq(dataSources.id, input.id));
      return results[0] ?? null;
    }),

  create: adminQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        type: z.enum(DATA_SOURCE_TYPES),
        config: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["connected", "disconnected", "error", "syncing"]).default("disconnected"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(dataSources).values(clean({
        name: input.name,
        type: input.type,
        config: input.config as Record<string, unknown>,
        status: input.status,
        createdBy: ctx.user?.id ?? null,
      }));
      const id = Number(result.lastInsertRowid);
      await logAudit(ctx, "datasource", "create", id, input as Record<string, unknown>);
      const notice = syncIntervalNotice(input.config);
      return notice ? { id, notice } : { id };
    }),

  update: adminQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["connected", "disconnected", "error", "syncing"]).optional(),
        lastError: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(dataSources).set(clean(data as Record<string, unknown>)).where(eq(dataSources.id, id));
      await logAudit(ctx, "datasource", "update", id, input as Record<string, unknown>);
      const notice = syncIntervalNotice(input.config);
      return notice ? { success: true, notice } : { success: true };
    }),

  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(dataSources).where(eq(dataSources.id, input.id));
      await logAudit(ctx, "datasource", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  // 测试连接 — 一律真走连接器的 testConnection（会改写数据源状态并以服务端身份外呼，提权管理员）。
  // 解析不出可用连接器 / 连接器自己抛错时明确失败，绝不留"没做任何检查就盖 connected"的通路（t12）。
  testConnection: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(dataSources).where(eq(dataSources.id, input.id));
      const ds = results[0];
      if (!ds) return { success: false, message: "数据源不存在" };

      if (!isImplementedDataSourceType(ds.type)) {
        return { success: false, reason: "unsupported", type: ds.type, message: "类型未实现" };
      }

      const config = (ds.config as Record<string, unknown>) || {};
      // t12：与 sync 共用 resolveConnectorFor —— 解析不出可用连接器就明确失败。
      // 原"通用连接测试"分支（什么都不查 → 写 connected → 回"连接成功"）连同它那个
      // 空壳 try/catch 一并删除：没做过任何检查，就不许宣告连接成功。
      const resolved = resolveConnectorFor(ds.type, config);
      if (!resolved.ok) {
        const reason = `${resolved.reason}，无法测试连接`;
        await db.update(dataSources)
          .set({ status: "error", lastError: reason })
          .where(eq(dataSources.id, input.id));
        return { success: false, message: reason };
      }

      try {
        const result = await resolved.connector.testConnection(config);
        await db.update(dataSources)
          .set({
            status: result.success ? "connected" : "error",
            lastError: result.success ? null : result.message,
          })
          .where(eq(dataSources.id, input.id));
        return result;
      } catch (err) {
        // 连接器自己抛错（如取 token 就炸了）：如实记 error，
        // 绝不让状态停在上一轮的 connected、也不把原始异常裸抛给客户端。
        console.error("[DataSource] testConnection failed:", err);
        const reason = `连接测试异常：${err instanceof Error ? err.message : "Internal error"}`;
        await db.update(dataSources)
          .set({ status: "error", lastError: reason })
          .where(eq(dataSources.id, input.id));
        return { success: false, message: reason };
      }
    }),

  // 同步文件 — 使用连接器获取文件列表并进入 ingestion 流水线（重操作，提权管理员）
  sync: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const results = await db.select().from(dataSources).where(eq(dataSources.id, input.id));
      const ds = results[0];
      if (!ds) return { success: false, message: "数据源不存在" };

      if (!isImplementedDataSourceType(ds.type)) {
        return { success: false, synced: false, reason: "unsupported", type: ds.type, message: "该数据源类型尚未实现同步" };
      }

      const config = (ds.config as Record<string, unknown>) || {};
      // 与 testConnection 共用 resolveConnectorFor（t12）——两条入口对"这个源到底能不能连"
      // 只允许有一个答案。resolvePlatform 的类型名兜底（nas → "nas"、rss → "rss"）仍在里面。
      const resolved = resolveConnectorFor(ds.type, config);

      await db.update(dataSources)
        .set({ status: "syncing" })
        .where(eq(dataSources.id, input.id));

      try {
        // 解析不出可用连接器 = 本轮连"去哪儿取条目"都不知道，一条也不可能同步。
        // 旧实现在此写 status:"connected" + lastSyncAt 并返回 success:"同步完成"，
        // 与刚修掉的「testConnection 零出网宣告连接成功」是同一类缺陷（t11 问题 A）：
        // 没干活却报成功，还会盖上时间戳让数据源看起来"刚同步过"。现在明确失败。
        if (!resolved.ok) {
          const reason = `${resolved.reason}，未执行同步`;
          await db.update(dataSources)
            .set({ status: "error", lastError: reason })
            .where(eq(dataSources.id, input.id));
          return { success: false, message: reason };
        }

        const { platform, connector } = resolved;
        const files = await connector.listFiles(config);
        const jobId = (await db.insert(ingestionJobs).values({
          sourceType: "datasource",
          sourceId: String(ds.id),
          status: "running",
          totalItems: files.length,
          processedItems: 0,
          failedItems: 0,
          error: null,
          retryCount: 0,
          metadata: { platform, dataSourceName: ds.name },
          createdBy: ctx.user?.id ?? null,
        })).lastInsertRowid;

        // 归档文件夹懒创建（2026-10-01）：只有真的要落库时才建「数据源/<源名>」，
        // 空源/全跳过的源不留空夹；同一轮内复用（memo）。
        let archiveFolderId: number | null = null;
        const archiveFolder = async (): Promise<number> => {
          if (archiveFolderId === null) {
            archiveFolderId = await ensureDatasourceFolder(db, ds.name, ctx.user?.id ?? null);
          }
          return archiveFolderId;
        };

        // 计数桶互斥（见 syncSummaryMessage 口径说明）：processed 只代表"真的入库成功了"，
        // 跳过与非 file 条目各归各的桶，绝不再顺手 processed++。
        let processed = 0;
        let failed = 0;
        let skipped = 0;
        let ignored = 0;

        for (const file of files) {
          if (file.type !== "file") {
            ignored++;
            continue;
          }

          // 去重键：externalId + sourceUrl + dataSourceId + platform（四条必须同时相等）。
          // ⚠️ metadata 里取出的两个值都要先 CAST 成 TEXT 再比：SQLite 3.38+ 的 `->>` 把 JSON 值
          // 转成**对应存储类**的 SQL 值（数字 → INTEGER，字符串 → TEXT），而这里的比较值是 JS
          // 字符串（better-sqlite3 按 TEXT 绑定）。SQLite 不做 INTEGER↔TEXT 的隐式相等，
          // `metadata->>'$.dataSourceId' = '1'` 对 {"dataSourceId":1} **恒为假** —— 于是整条去重
          // 查询对所有连接器永不命中，每一轮 sync 都把整个源重刷一遍（真库实测，t14 用例钉住）。
          const existing = await db
            .select()
            .from(ingestionItems)
            .where(
              and(
                eq(ingestionItems.externalId, file.id),
                // M-2：查询键与下面落库的 sourceUrl 必须同口径 —— 无链接一律 ""。
                // （历史行存的就是 ""；旧写法查询用 ""、落库传 undefined→NULL，永远对不上。）
                eq(ingestionItems.sourceUrl, file.downloadUrl ?? ""),
                sql`CAST(${ingestionItems.metadata}->>'$.dataSourceId' AS TEXT) = ${String(ds.id)}`,
                sql`CAST(${ingestionItems.metadata}->>'$.platform' AS TEXT) = ${platform}`
              )
            )
            .orderBy(desc(ingestionItems.createdAt))
            .limit(1);

          const existingItem = existing[0];
          const existingModifiedAt = (existingItem?.metadata as Record<string, unknown> | undefined)?.remoteModifiedAt as string | undefined;
          const newModifiedAt = file.modifiedAt?.toISOString();
          // 去重键命中 = 这条条目以前进过库。此时**只有**"两侧时间戳都有值且远端确实变新"才重新入库；
          // 任一侧缺时间戳 = 无法判断有没有变化，按"无变化"跳过（M-3）。
          // 旧写法是 `existingModifiedAt && newModifiedAt && ...` 才比较，等于把所有缺时间戳的条目
          // 判成"永远可能变了"→ 每轮重入一份。而缺值是常态不是例外：RSS 条目可以没有 pubDate，
          // 115 连接器压根不填 mtime（alist / aliyundrive 上游不给 modified 时也是 undefined）。
          // 取舍：宁可漏掉一次原地更新（延迟，下一轮带上时间戳或人工重跑可补），
          // 也不再往知识库里刷重复文档（已发生、可观测，且污染检索与统计）。
          // 有 mtime 的源（alist / nas 的正常文件）两侧都有值，走的仍是原来那条比较，行为零变化。
          if (existingItem && (!existingModifiedAt || !newModifiedAt || existingModifiedAt >= newModifiedAt)) {
            skipped++;
            continue;
          }

          // 直发正文路径（决策 A：RSS 只入库 feed 自带摘要/正文，绝不抓文章页）。
          // 仅实现 getContent 的连接器（当前只有 rss）走此分支：
          //   - getContent 返回 null → 该条目无正文 → 计入 skipped 并记日志，绝不回退抓 downloadUrl（避免 HTML 脏数据）；
          //   - 正文为空 → 脏数据，计入 failed（不静默标成功）；
          //   - 正常 → 写临时文件、以 storagePath 入库（不传 downloadUrl）。
          // **未**实现 getContent 的连接器（115/aliyundrive/nas/alist 网盘类）维持原 downloadUrl 抓取，行为零回归。
          let inlineTempPath: string | undefined;
          try {
            if (connector.getContent) {
              const inline = await connector.getContent(config, file.id);
              if (!inline) {
                console.warn(`[DataSource] Entry ${file.id} ("${file.name}") has no inline content from connector ${platform}; skipped (not fetching article page)`);
                skipped++;
                continue;
              }
              if (!inline.content) {
                throw new Error(`Empty inline content for entry ${file.id} ("${file.name}")`);
              }
              const dir = path.resolve(env.uploadDir);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              inlineTempPath = path.join(dir, `ds-feed-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
              fs.writeFileSync(inlineTempPath, inline.content, "utf-8");
              await ingestFile({
                sourceType: "datasource",
                sourceId: String(ds.id),
                fileName: inline.fileName,
                mimeType: inline.mimeType,
                size: Buffer.byteLength(inline.content),
                externalId: file.id,
                // 关键：sourceUrl 保持条目链接不变（去重靠 externalId + sourceUrl），
                // 且不传 downloadUrl，避免 ingestion 去抓取文章网页。
                // M-2：无链接一律 ""，与上面去重查询的 `file.downloadUrl ?? ""` 同口径 ——
                // 传 undefined 会被 ingestion 落成 NULL，而 SQL 里 NULL ≠ ""，去重永不命中。
                sourceUrl: file.downloadUrl ?? "",
                storagePath: inlineTempPath,
                // inlineContent 标记：正文已入 kb_documents/chunks/向量，临时文件返回后即删，
                // ingestionItems.storagePath 是悬空路径、当前无消费方——以此标记区分"内联直发"与真实落盘文件。
                metadata: { dataSourceId: ds.id, platform, remoteModifiedAt: newModifiedAt, inlineContent: true },
                createdBy: ctx.user?.id ?? null,
                folderId: await archiveFolder(),
              });
            } else {
              const downloadUrl = file.downloadUrl ?? (await connector.getDownloadUrl(config, file.id));
              await ingestFile({
                sourceType: "datasource",
                sourceId: String(ds.id),
                fileName: file.name,
                mimeType: file.mimeType || "application/octet-stream",
                size: file.size ?? 0,
                externalId: file.id,
                // M-2：与去重查询同口径 —— listFiles 没给 downloadUrl 就存 ""（不是 NULL）。
                // 网盘类连接器常靠 getDownloadUrl 现取临时链接，把它当 sourceUrl 反而每轮都变，
                // 稳定的 externalId + "" 才是这里的去重键。
                sourceUrl: file.downloadUrl ?? "",
                downloadUrl: downloadUrl ?? undefined,
                metadata: { dataSourceId: ds.id, platform, remoteModifiedAt: newModifiedAt },
                createdBy: ctx.user?.id ?? null,
                folderId: await archiveFolder(),
              });
            }
            processed++;
          } catch (err) {
            failed++;
            console.error(`[DataSource] Ingest failed for ${file.name}:`, err);
          } finally {
            // ingestFile 对传入的 storagePath 判定 isTemp=false、不会代删临时文件，由此处负责清理；
            // 正文在 parseFileToText 阶段已入库，返回后删除安全。删除失败不得影响同步结果。
            if (inlineTempPath) {
              try {
                fs.unlinkSync(inlineTempPath);
              } catch {
                /* 清理失败吞掉 */
              }
            }
          }
        }

        config.documentCount = files.length;

        // 状态判定只看"本轮到底有没有东西真的落库"：
        //   零失败            → 作业 completed + 数据源 connected（全跳过也算正常空跑，success: true）
        //   有失败但也有成功  → 部分成功：作业/数据源保留 completed / connected，
        //                       但靠 failedItems + lastError 记录损失，且 success: false、消息标"部分成功"
        //   一条都没成功      → 作业 failed + 数据源 error（绝不能被跳过项掺水成 connected）
        // 旧判据 processed === failed 之所以会漏，是因为 processed 里混了 skipped / ignored。
        //
        // 零条目源（t10）为什么仍然 connected、仍然盖 lastSyncAt：
        //   连接器 listFiles 正常返回空数组，说明源**确实可达且合法**，只是当下没内容 ——
        //   这与"连不上/配置错"（error）是两回事，判 error 会把可达的源误报成故障。
        //   lastSyncAt 记录的是"最近一次同步动作发生的时间"，本轮动作真实发生过，盖它不算假。
        //   真正的诚实性由**消息**承担：syncSummaryMessage 在 entryCount===0 时改口说
        //   "源当前没有可同步的条目（0 条）—— 本轮没有任何内容入库"，
        //   与 testConnection 的"没有可同步的内容"同调，绝不写出任何入库量。
        const nothingLanded = failed > 0 && processed === 0;

        await db.update(ingestionJobs)
          .set({ processedItems: processed, failedItems: failed, status: nothingLanded ? "failed" : "completed" })
          .where(eq(ingestionJobs.id, Number(jobId)));

        await db.update(dataSources)
          .set({
            status: nothingLanded ? "error" : "connected",
            lastSyncAt: new Date(),
            config,
            lastError: failed > 0 ? `${failed} 个文件入库失败` : null,
          })
          .where(eq(dataSources.id, input.id));

        return {
          success: failed === 0,
          message: syncSummaryMessage(files.length, processed, skipped, ignored, failed),
        };
      } catch (err) {
        console.error("[DataSource] sync failed:", err);
        await db.update(dataSources)
          .set({ status: "error", lastError: "Internal error" })
          .where(eq(dataSources.id, input.id));
        return { success: false, message: "同步失败" };
      }
    }),

  // 内容流（2026-10-01）：数据源页「内容」按钮的后端。按源聚合（跨同步批次）、时间倒序、
  // 只收 completed —— 用户直接读入库内容，不必去知识库全库搜索。
  /**
   * 历史内容归位（2026-10-01）：把按源归档上线**之前**入库、如今仍悬空（folderId IS NULL）
   * 的文档，挪进各自的「数据源/<源名>」文件夹。幂等、可反复点。
   * 取舍：**只动悬空文档** —— 用户手动归档过的位置一律不碰。
   */
  organizeExisting: adminQuery.mutation(async ({ ctx }) => {
    const db = getDb();
    const sources = await db
      .select({ id: dataSources.id, name: dataSources.name })
      .from(dataSources);

    let moved = 0;
    let folders = 0;
    for (const src of sources) {
      const rows = await db
        .select({ documentId: ingestionItems.documentId })
        .from(ingestionItems)
        .where(and(
          isNotNull(ingestionItems.documentId),
          // 与 sync 去重、内容流同口径：CAST AS TEXT 逐字比对 dataSourceId
          sql`CAST(${ingestionItems.metadata}->>'$.dataSourceId' AS TEXT) = ${String(src.id)}`,
        ));
      const docIds = rows
        .map((r) => r.documentId)
        .filter((v): v is number => typeof v === "number" && v > 0);
      if (docIds.length === 0) continue;

      const folderId = await ensureDatasourceFolder(db, src.name, ctx.user?.id ?? null);
      folders += 1;
      const updated = await db
        .update(kbDocuments)
        .set({ folderId })
        .where(and(inArray(kbDocuments.id, docIds), isNull(kbDocuments.folderId)));
      moved += Number(updated.changes ?? 0);
    }
    return { moved, folders };
  }),

  getContentStream: authedQuery
    .input(z.object({ dataSourceId: z.number().int() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select({
          id: ingestionItems.id,
          jobId: ingestionItems.jobId,
          name: ingestionItems.name,
          sourceUrl: ingestionItems.sourceUrl,
          documentId: ingestionItems.documentId,
          createdAt: ingestionItems.createdAt,
        })
        .from(ingestionItems)
        .where(and(
          // SQLite 的 ->> 取出 JSON 值后与 TEXT 比较恒不等（历史去重 bug 同源），
          // 必须 CAST AS TEXT 逐字比对 —— 与 sync 去重口径一致，测试钉死
          sql`CAST(${ingestionItems.metadata}->>'$.dataSourceId' AS TEXT) = ${String(input.dataSourceId)}`,
          eq(ingestionItems.status, "completed"),
        ))
        .orderBy(desc(ingestionItems.createdAt))
        .limit(200);
    }),
});
