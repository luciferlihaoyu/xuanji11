/**
 * RSS / Atom 数据源连接器（只读）
 * 配置：{ url: "https://example.com/feed.xml", apiKey?: "" }
 * 免鉴权：authType 沿用 'apikey' 形态但 apiKey 留空即可（订阅地址本身即凭据）。
 *
 * 数据链路与网盘不同：feed 不是"文件"，条目正文直接来自 feed 内联内容。
 * 因此实现 base.CloudConnector 的可选 getContent()，datasource-router.sync 会把返回的
 * markdown 写成临时文件走 storagePath 入库（不再传 downloadUrl 去抓文章网页）。
 *
 * ⚠️ 性能要点：sync 的条目循环里「每个条目调一次 getContent」。若无缓存，20 条 = 20 次请求，
 * 75 条 = 75 次请求 —— 对源站是骚扰且必然撞限流。本模块在连接器内做**按 feed URL 的短期缓存**：
 * 一次 sync 里 listFiles + N×getContent（+ getDownloadUrl / testConnection）合计只发 1 次 HTTP。
 * 缓存有三重护栏：TTL（默认 45s，短到不会让多次 sync 拿到陈旧 feed）、单 feed 条目数上限、
 * 缓存的 feed URL 数上限（超限按最旧淘汰）；失败一律不写缓存，并发请求做 in-flight 去重。
 *
 * ⚠️ 安全要点（SSRF）：用户可粘贴任意订阅地址，所以每一次出网都必须过 assertEgressAllowed。
 * 重定向尤其危险 —— 若交给 fetch 自动跟随（redirect:'follow'），源站回一个 302 → 127.0.0.1
 * 就能绕过门禁直取内网（复核者已用真实 socket 探针证实可利用）。因此这里用
 * **redirect:'manual' + 自己逐跳跟随**：每跳的 Location 先解析成绝对 URL、再过协议白名单与
 * egress 校验，才允许发出下一跳；跳数受 MAX_REDIRECTS 约束。
 * 另：实际出网走 safeFetch（2026-10-01）——它把「解析 DNS → 判定 → 连接」钉成一次动作，
 * 只连判定通过的地址，堵死"两次解析之间 DNS 被换"（DNS-rebinding TOCTOU）这一深层竞态；
 * 逐跳 assertEgressAllowed 保留为纵深防御（缓存命中复核、策略中途收紧的场景仍由它兜住）。
 * 缓存命中时同样按快照里的**每一跳**复核（策略可能在 TTL 内收紧）；复核不过**不报错**，
 * 而是丢弃该缓存、重新走完整的逐跳抓取与校验 —— 旧跳链作废（CDN 轮换/签名 URL 变更/临时解析失败）
 * 不该把可达的源判死整个 TTL，而重新抓取本身就是再一次完整校验，绝不构成放行（N-2）。
 *
 * ⚠️ 口径要点：testConnection 报的「条数」与 listFiles 的条数必须来自**同一份条目集合**
 * （见 buildSnapshot），否则闸门显示「有内容」而同步时一条都进不去（历史上正是 id 为空的
 * 怪源被 listFiles 静默丢掉造成的分叉）。
 */

import { registerConnector, type CloudConnector, type CloudFile } from './base';
import { assertEgressAllowed } from '../lib/egress';
import { safeFetch, type SafeFetchResponse } from '../lib/safe-fetch';
import { parseFeed, type FeedEntry, type ParsedFeed } from './feed-parse';

/** 整条「抓取链」的总超时（含所有重定向跳）：一次 signal 贯穿全链，不逐跳续期 */
const TIMEOUT_MS = 30_000;
/** 固定 UA：便于源站识别与放行，也便于排查异常流量来源 */
const USER_AGENT = 'Xuanji-RSS/1.0 (+https://xuanji.xianrealme.com; xuanji-datasource-connector)';
const ACCEPT_HEADER =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

/** feed 解析结果缓存 TTL：30~60s 区间内取值。
 *  够短 —— 跨 sync 不会长期复用陈旧内容；够长 —— 一次 sync 的 N 次 getContent 必然命中。 */
export const FEED_CACHE_TTL_MS = 45_000;
/** 单个 feed 最多缓存/列出的条目数（防超大 feed 把内存吃穿；超出部分丢弃，见 fetchFeed） */
export const FEED_MAX_ENTRIES = 500;
/** 最多缓存多少个 feed URL（超出按最旧淘汰），限制长期累积 */
const FEED_MAX_URLS = 32;
/** 响应体**字节**上限（content-length 预检 + 边读边按字节累计拦截；不按字符数，CJK 一字 3 字节） */
export const FEED_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 手动跟随重定向的跳数上限：最多发 1 + MAX_REDIRECTS 次请求（首跳 + 每一跳各一次） */
export const MAX_REDIRECTS = 5;
/** 文件名主干最大长度（码点数，非字节数） */
const FILE_NAME_MAX = 80;
/** 提示文案里 feed 标题的展示上限（码点）：超长标题不许撑爆日志/UI */
const CLIP_TITLE = 60;
/** 提示文案里「细节」（解析器报错、原始头部值、超长地址等）的展示上限（码点） */
const CLIP_DETAIL = 160;

// ---------------------------------------------------------------- 配置

type ConfigResult = { url: string } | { error: string };

function validateConfig(config: Record<string, unknown>): ConfigResult {
  const raw = typeof config.url === 'string' ? config.url.trim() : '';
  if (!raw) {
    return { error: '缺少 feed 地址配置 (url)：请填写 RSS/Atom 订阅地址，例如 https://example.com/feed.xml' };
  }
  if (!/^https?:\/\//i.test(raw)) {
    return { error: `feed 地址必须以 http:// 或 https:// 开头（当前：${clipText(raw, CLIP_DETAIL)}）` };
  }
  return { url: raw };
}

/** 取 url，非法即抛 —— 供 listFiles/getContent/getDownloadUrl 给出明确错误，绝不静默返回空 */
function requireUrl(config: Record<string, unknown>): string {
  const r = validateConfig(config);
  if ('error' in r) throw new Error(r.error);
  return r.url;
}

// ---------------------------------------------------------------- 小工具

/** 按码点截断并在超长时补省略号：任何拼进提示文案的外部文本都撑不爆日志 */
function clipText(s: string, max: number): string {
  const chars = Array.from(s ?? '');
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- 短期缓存

/** 一个条目 + 它在「本次 feed」里确定下来的 id（真实 guid/link/title，或合成 id） */
interface FeedItem {
  id: string;
  entry: FeedEntry;
}

/** 一次抓取的可消费快照：闸门（testConnection）与列表（listFiles）共用同一份 items */
interface FeedSnapshot {
  title: string;
  items: FeedItem[];
  byId: Map<string, FeedItem>;
  /** 本次真实走过的地址链（首跳 + 每一跳，绝对 URL）：缓存命中时按它复核 egress 策略 */
  hops: string[];
}

interface FeedCacheRecord {
  snapshot: FeedSnapshot;
  fetchedAt: number;
}

const feedCache = new Map<string, FeedCacheRecord>();
/** 同一 URL 的并发请求共享同一个 promise（in-flight 去重），避免并发 getContent 各发一次 */
const inflight = new Map<string, Promise<FeedSnapshot>>();

/** 测试/运维用：清空 feed 解析缓存 */
export function clearFeedCacheForTests(): void {
  feedCache.clear();
  inflight.clear();
}

function remember(url: string, snapshot: FeedSnapshot): void {
  const now = Date.now();
  for (const [key, rec] of feedCache) {
    if (now - rec.fetchedAt >= FEED_CACHE_TTL_MS) feedCache.delete(key);
  }
  while (feedCache.size >= FEED_MAX_URLS) {
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, rec] of feedCache) {
      if (rec.fetchedAt < oldest) {
        oldest = rec.fetchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    feedCache.delete(oldestKey);
  }
  feedCache.set(url, { snapshot, fetchedAt: now });
}

/** 缓存命中时对快照记录的**每一跳**重新过一遍门禁（策略可能在 TTL 内被收紧）。
 *  返回 null = 全部通过；返回错误原因 = 这一份缓存已经不可信。
 *  注意：这里只负责"判定"，不负责"下结论"——失败的处理（丢弃缓存重抓）在调用方，见 loadFeed。 */
async function revalidateHops(hops: readonly string[]): Promise<string | null> {
  // 空地址链 = 无从复核（正常抓取至少记下一跳，走到这里说明快照不可信），按"复核不过"处理。
  if (hops.length === 0) return 'cached snapshot has no hop chain to re-check';
  for (const hopUrl of hops) {
    try {
      await assertEgressAllowed(hopUrl);
    } catch (e) {
      return errMessage(e);
    }
  }
  return null;
}

async function loadFeed(url: string): Promise<FeedSnapshot> {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.fetchedAt < FEED_CACHE_TTL_MS) {
    // 只复核**当时真实走过的每一跳**（首跳即本函数的 url，hops[0] 恒等于它，见
    // fetchWithPerHopEgressGuard）——所以这里不需要再对 url 单独校验一次（N-1：
    // 此前第 0 跳被 assertEgressAllowed 校验两遍，靠 egress 的 60s passCache 兜住，属冗余）。
    const blocked = await revalidateHops(hit.snapshot.hops);
    if (!blocked) return hit.snapshot;
    // N-2：复核不过**不直接报错**。缓存里的跳链是上一轮真实走过的地址，合法源做 CDN 轮换 /
    // 换签名 URL / 那一跳临时解析失败时，旧地址作废而新链路完全可用 —— 继续用缓存或就此报错
    // 都会把可达的源判死整个 TTL（最长 45s）。正确处理：丢弃这一项缓存，重新走完整的逐跳抓取
    // （完整校验一遍全新链路）。这不是放行：下面的 fetchFeed 对每一跳照样 assertEgressAllowed，
    // 若新链路仍落在被拦目标上，照旧明确失败且一个请求都不会发给该目标。
    feedCache.delete(url);
    console.warn(`[RSS] 缓存复核未通过（${clipText(blocked, CLIP_DETAIL)}），丢弃缓存重新抓取：${clipText(url, 120)}`);
  }

  const pending = inflight.get(url);
  if (pending) return pending;

  const task = fetchFeed(url).then(({ feed, hops }) => {
    const snapshot = buildSnapshot(url, feed, hops);
    remember(url, snapshot);
    return snapshot;
  });
  inflight.set(url, task);
  try {
    return await task;
  } finally {
    // 失败不写缓存：下一次调用重新抓取
    inflight.delete(url);
  }
}

// ---------------------------------------------------------------- 条目集合（闸门与列表的唯一口径）

/** FNV-1a 32 位（可给种子）→ 6 位 base36：合成 id 的取值域，稳定且与内容/位置绑定 */
function fnv1aBase36(input: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}

/** 合成 id：`entry-<12 位 base36>`（两段不同种子的哈希拼接，降低撞库概率）。
 *  上游对「无 guid / 无 link / 无 title」的条目给 id:""，历史上被 listFiles 静默丢弃，
 *  于是闸门说「有 N 条」、同步时一条都进不去。这里给它们一个**稳定**的 id。
 *
 *  ⚠️ 种子里**绝不含条目下标**（M-1）：id 就是下游 ingestionItems.externalId（去重主键），
 *  掺进位置后「同一内容在 feed 里挪了个位置」= 换一个 id = 已入库条目被当新条目再入一遍。
 *  订阅源每天在顶部插新条目，所以带下标的种子会让**每次同步都产出一批重复文档**。
 *  现在的口径是「内容寻址 + 同内容在本次解析中的出现序号」：
 *    - 内容与 feed 地址不变 → id 不变（其它条目增删、本条目前后移动都不影响）；
 *    - 两条内容完全相同的条目 → 出现序号不同 → id 不同（不许互撞合并）。
 *  已知代价（刻意的取舍）：同一条内容的「第 N 次出现」在它**前面同内容的条目**数量变化时
 *  会变（如 [X,X] 顶部再插一条 X → 序号 0,1 变 1,2）。这只影响「源站重复推完全相同的裸条目」
 *  这种病态形态，正常 feed 的同内容重复不随日常插新条目变化。 */
function syntheticEntryId(seed: string): string {
  return `entry-${fnv1aBase36(seed, 0x811c9dc5)}${fnv1aBase36(`${seed}\u0001`, 0x9e3779b9)}`;
}

/** 正文优先 content，缺失时回退 summary（size / 合成 id / markdown 三处口径必须一致） */
function entryBody(entry: FeedEntry): string {
  return entry.content && entry.content.trim() ? entry.content : entry.summary;
}

/** 条目是否「有可用内容」：标题、链接、正文至少有一个非空（与上游空壳过滤同口径，
 *  但不依赖上游 —— 上游行为变化时闸门与列表不会再次分叉） */
function isUsableEntry(entry: FeedEntry): boolean {
  if (entry.title?.trim()) return true;
  if (entry.link?.trim()) return true;
  return Boolean(entryBody(entry).trim());
}

/** 把解析结果整理成「连接器视角的条目集合」：过滤空壳 → 定 id（真实优先，空则合成）→ 按 id 去重。
 *  feedIdentity 用用户配置的 feed 地址（不是重定向后的最终地址）：它跨 sync 稳定，
 *  且让不同 feed 的同内容条目拿到不同 id。 */
function buildSnapshot(feedIdentity: string, feed: ParsedFeed, hops: string[]): FeedSnapshot {
  const items: FeedItem[] = [];
  const byId = new Map<string, FeedItem>();
  /** 本次解析中「由合成得来」的 id 集合：用来区分「同 guid 的真重复」与「真实 id 撞别人的合成 id」 */
  const syntheticIds = new Set<string>();
  /** 同一份内容在本次解析中已经出现过几次（合成 id 的序号种子；与条目下标无关，见 syntheticEntryId） */
  const contentOccurrences = new Map<string, number>();
  let collisions = 0;

  for (const entry of feed.entries) {
    if (!isUsableEntry(entry)) continue;

    const realId = typeof entry.id === 'string' ? entry.id.trim() : '';
    let id = realId;
    if (!id) {
      const published = entry.publishedAt ? entry.publishedAt.toISOString() : '';
      // 种子 = feed 地址 + 条目自身内容（标题/链接/发布时间/正文）——**不含下标**（M-1）。
      // 后缀 `#<出现序号>` 只用来把「内容完全相同的两条」分开，两者都与条目在 feed 里的位置无关。
      const contentSeed = [feedIdentity, entry.title, entry.link, published, entryBody(entry)].join('\u0000');
      const occurrence = contentOccurrences.get(contentSeed) ?? 0;
      contentOccurrences.set(contentSeed, occurrence + 1);
      const seed = `${contentSeed}\u0000#${occurrence}`;
      id = syntheticEntryId(seed);
      // 极端情况下合成 id 仍可能相撞（或与某个真实 id 相撞）：混入递增计数重算，保持确定性
      while (byId.has(id)) {
        collisions += 1;
        id = syntheticEntryId(`${seed}\u0000dup-${collisions}`);
      }
      syntheticIds.add(id);
    } else if (byId.has(id)) {
      if (syntheticIds.has(id)) {
        // N-4：来者带**真实** id，却撞上了一条先占坑的合成 id。
        // 旧代码在这里一律 `return`（静默丢弃）= 源站只要把某条 guid 写成另一条的 id，
        // 就能精准抑制掉那条内容，且不留任何痕迹。真重复要合并，但这种撞车必须两条都留：
        // 给来者加确定性的编号后缀（同 guid 的真重复走 else 分支，行为不变）。
        let n = 1;
        let candidate = id;
        while (byId.has(candidate)) {
          n += 1;
          collisions += 1;
          candidate = `${id}#${n}`;
        }
        id = candidate;
      } else {
        // 同 guid 的重复条目合并：externalId 是下游入库去重键，重复只会造成无谓的 getContent 与重复 ingest
        continue;
      }
    }

    const item: FeedItem = { id, entry };
    byId.set(id, item);
    items.push(item);
  }

  return { title: feed.title, items, byId, hops };
}

// ---------------------------------------------------------------- 抓取（重定向逐跳门禁）

/** 需要跟随的重定向状态码（3xx 里 304 不带 Location，按「无法确定目标」明确报错，绝不静默成功） */
function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** 决定不消费响应体时（跟随下一跳 / 各种提前报错）主动丢弃，避免连接挂在池里不释放。
 *  取消失败不影响结论（body 可能已被消费或本就为 null）。 */
function discardBody(res: SafeFetchResponse): void {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    /* 忽略：不可取消的形态 */
  }
}

/**
 * 手动逐跳跟随重定向，**每一跳都重新过 SSRF 门禁**。
 * redirect:'manual' 下拿到的 3xx 里 Location 可能是相对路径，必须先按当前地址解析为绝对 URL
 * 再校验（否则 new URL(相对) 抛错 / 校验对象错位，等于没校验）。
 */
async function fetchWithPerHopEgressGuard(
  startUrl: string,
  signal: AbortSignal,
): Promise<{ res: SafeFetchResponse; hops: string[] }> {
  let current = startUrl;
  /** 实际发出过请求的地址链（含被拦下的那一跳之前的一切），供缓存命中时复核策略 */
  const hops: string[] = [];

  for (let hop = 0; ; hop++) {
    // 出网前的最后一道闸：首跳与每一跳的目标地址都要重新校验（策略可能已变，缓存不算数）
    try {
      await assertEgressAllowed(current);
    } catch (e) {
      if (hop === 0) throw e;
      throw new Error(
        `${errMessage(e)}（RSS 第 ${hop + 1} 跳目标 ${clipText(current, 120)} 被出站安全策略拦截，已停止跟随）`,
      );
    }
    hops.push(current);

    let res: SafeFetchResponse;
    try {
      // 出网走 safeFetch：校验与连接钉成一次动作（解析一次→判定→只连判定通过的那个地址），
      // 上面的 assertEgressAllowed 保留为纵深防御；即便两次校验之间 DNS 被换（DNS-rebinding），
      // 实际连接也只允许去判定通过的地址，TOCTOU 从结构上不可能。
      res = await safeFetch(current, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT_HEADER },
        // 关键：绝不交给 fetch 静默跟随 —— 3xx 交回我们自己校验下一跳
        redirect: 'manual',
        signal,
      });
    } catch (e) {
      const why =
        e instanceof Error
          ? e.name === 'TimeoutError' || e.name === 'AbortError'
            ? `请求超时（${Math.round(TIMEOUT_MS / 1000)}s）`
            : e.message
          : String(e);
      throw new Error(`RSS 抓取失败：${clipText(why, CLIP_DETAIL)}`);
    }

    if (!isRedirectStatus(res.status)) return { res, hops };

    if (res.status === 304) {
      // 我们不做条件请求（不发 ETag / If-None-Match），304 意味着拿不到正文：
      // 多半是中间缓存异常。绝不"跟随"到一个不存在的目标，也不静默当空 feed。
      discardBody(res);
      throw new Error(
        'RSS 抓取失败: HTTP 304（未修改）—— 连接器不发条件请求，本不该收到 304，' +
          '通常是中间缓存/CDN 异常；没有正文可用，请稍后重试或检查订阅地址',
      );
    }

    const location = res.headers.get('location');
    if (!location || !location.trim()) {
      discardBody(res);
      throw new Error(
        `RSS 重定向失败：HTTP ${res.status} 响应没有 Location 头，无法确定跳转目标` +
          `（不会把它当成空 feed 静默成功）`,
      );
    }
    if (hop >= MAX_REDIRECTS) {
      discardBody(res);
      throw new Error(
        `RSS 重定向次数超过上限（最多跟随 ${MAX_REDIRECTS} 跳），已停止：最后地址 ${clipText(current, 120)}`,
      );
    }

    let next: URL;
    try {
      next = new URL(location.trim(), current);
    } catch {
      discardBody(res);
      throw new Error(`RSS 重定向目标无法解析为绝对地址：${clipText(location, CLIP_DETAIL)}`);
    }
    // 协议白名单先于出网：file:// / gopher:// / javascript:// 一律拒绝，且一个请求都不发
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      discardBody(res);
      throw new Error(
        `RSS 重定向目标协议不被允许：${next.protocol}（仅支持 http/https），已停止跟随`,
      );
    }
    if (next.toString() === current) {
      discardBody(res);
      throw new Error(`RSS 重定向成环：Location 指回当前地址 ${clipText(current, 120)}，已停止跟随`);
    }
    // 本跳的响应体不再需要（3xx 的正文不参与解析），先丢掉再发下一跳
    discardBody(res);
    current = next.toString();
  }
}

/** content-length 预检：源站自己声明超限就不必读体（省带宽，也防"声明超限却先发完整头"的拖延） */
function checkDeclaredLength(res: SafeFetchResponse): void {
  const raw = res.headers.get('content-length');
  if (raw === null) return;
  const declared = Number(raw.trim());
  if (Number.isFinite(declared) && declared > FEED_MAX_BODY_BYTES) {
    discardBody(res);
    throw new Error(
      `RSS 内容过大（源站声明 content-length ${declared} 字节，超过上限 ${FEED_MAX_BODY_BYTES} 字节），已拒绝加载`,
    );
  }
}

/** 按字节护栏读取响应体：边读边累计字节数，超限立即中断并取消 reader（绝不把 12MB 全抽完） */
async function readBodyWithByteCap(res: SafeFetchResponse): Promise<string> {
  checkDeclaredLength(res);

  const stream = res.body;
  if (!stream || typeof stream.getReader !== 'function') {
    // 无流可读（理论上只剩 body 为 null 的形态）：回退一次性取文本，仍按字节兜底
    const text = await res.text();
    return guardActualBytes(text, '一次性读取');
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const parts: string[] = [];
  let received = 0;
  let overflow = false;

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value) continue;
      received += value.byteLength;
      if (received > FEED_MAX_BODY_BYTES) {
        overflow = true;
        break;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // 流中途报错（连接被切断、body stream terminated、非法编码等）包装成可读错误，
    // 绝不把裸 TypeError 抛给调用方 —— 用户只看得到 "TypeError" 等于没得到诊断信息。
    throw new Error(`RSS 响应体读取失败（连接中断或内容被截断）：${clipText(errMessage(e), CLIP_DETAIL)}`);
  } finally {
    // 提前 break（超限）时主动取消，避免源站继续推流与连接泄漏；取消失败不影响结论
    void reader.cancel().catch(() => {});
  }

  if (overflow) {
    throw new Error(
      `RSS 内容过大（读取中已累计 ${received} 字节，超过上限 ${FEED_MAX_BODY_BYTES} 字节），已中断读取`,
    );
  }

  let text: string;
  try {
    parts.push(decoder.decode());
    text = parts.join('');
  } catch (e) {
    throw new Error(`RSS 响应体解码失败（非 UTF-8 或内容被截断）：${clipText(errMessage(e), CLIP_DETAIL)}`);
  }
  return guardActualBytes(text, '读取完成');
}

/** 兜底：实读字节数仍超限（例如源站谎报 content-length）则拒绝 */
function guardActualBytes(text: string, stage: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > FEED_MAX_BODY_BYTES) {
    throw new Error(
      `RSS 内容过大（${stage}后实测 ${bytes} 字节，超过上限 ${FEED_MAX_BODY_BYTES} 字节），已拒绝加载`,
    );
  }
  return text;
}

/** Retry-After 归一化：秒数直接用；HTTP 日期换算剩余秒数；无法识别返回 null（绝不臆造时间） */
export function parseRetryAfterSeconds(
  raw: string | null,
  now: number = Date.now(),
): number | null {
  const value = raw === null ? '' : raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const secs = Number(value);
    return Number.isSafeInteger(secs) ? secs : null;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function rateLimitMessage(res: SafeFetchResponse): string {
  const base = 'RSS 源站限流 (HTTP 429)：请求过于频繁';
  const raw = res.headers.get('retry-after');
  const secs = parseRetryAfterSeconds(raw);
  if (secs !== null) return `${base}，请在 ${secs} 秒后重试（Retry-After）`;
  if (raw && raw.trim()) {
    // 值认不出来：如实说明，不显示 NaN，也不假装知道几点能重试
    return `${base}，Retry-After 值无法识别（${clipText(raw.trim(), 40)}），请稍后重试`;
  }
  return `${base}，源站未告知重试时间，请稍后重试`;
}

async function fetchFeed(url: string): Promise<{ feed: ParsedFeed; hops: string[] }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const { res, hops } = await fetchWithPerHopEgressGuard(url, signal);

  if (res.status === 429) {
    discardBody(res);
    throw new Error(rateLimitMessage(res));
  }
  if (!res.ok) {
    discardBody(res);
    throw new Error(
      `RSS 抓取失败: HTTP ${res.status}${res.statusText ? ` ${clipText(res.statusText, 60)}` : ''}`,
    );
  }

  const body = await readBodyWithByteCap(res);

  let feed: ParsedFeed;
  try {
    feed = parseFeed(body);
  } catch (e) {
    // 只看状态码会把 HTML 页面当成"0 条成功"；这里以内容为准，把解析器的报错转成可读结论
    throw new Error(
      `该地址返回的不是 RSS/Atom feed（HTTP ${res.status} 但内容无法识别）：${clipText(errMessage(e), CLIP_DETAIL)}`,
    );
  }

  if (feed.entries.length > FEED_MAX_ENTRIES) {
    // 内存护栏：只保留前 FEED_MAX_ENTRIES 条（多余的条目对 2C 常驻服务没有价值）
    return {
      feed: { title: feed.title, entries: feed.entries.slice(0, FEED_MAX_ENTRIES) },
      hops,
    };
  }
  return { feed, hops };
}

// ---------------------------------------------------------------- 文件名安全化

/** 非法文件名字符（含路径分隔符与控制字符；\p{Cc} = U+0000–U+001F 与 U+007F–U+009F）
 *  → 统一换成空格，避免把相邻词粘在一起 */
const ILLEGAL_FILE_CHARS = /[/\\:*?"<>|\p{Cc}]/gu;
/** Cf 格式控制符（不可见 / 可伪造视觉顺序）→ **直接删除**（换空格会把单词拆坏）：
 *  软连字符 U+00AD、组合保留符 U+034F、阿拉伯文标记 U+061C/U+070F/U+08E2、蒙古文选择符 U+180E、
 *  零宽族 U+200B–U+200D、双向标记 U+200E/U+200F、双向控制覆盖 U+202A–U+202E、
 *  词连接符与不可见运算族 U+2060–U+2064、单向隔离 U+2066–U+2069、BOM U+FEFF。
 *  有意**不**包含 U+FE0E/U+FE0F（emoji 变体选择符）：它们也是 Cf，但删掉会把 ❤️ 之类降级，
 *  既非隐蔽攻击载体，就不该拿显示效果换清白。 */
const FORMAT_CONTROL_CHARS =
  /[\u00AD\u034F\u061C\u070F\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u{FEFF}]/gu;
/** Windows 保留设备名：**按首段判定**（"CON.txt" 在 Windows 上同样不可创建，
 *  而 "CONE" 不是保留名，不能误伤）。com/lpt 只到 1–9，"com10" 合法。 */
const RESERVED_FIRST_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 6 位稳定短哈希（djb2 → base36），用于空标题的回退名，保证不同条目可区分 */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(-6);
}

/** 按码点截断，避免把代理对（emoji 等）切坏 */
function clampChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

/** 反复剥离首尾的「点与空白」直到不动点：单次 replace 会被 ".. .. x .. .." 这类交替形态骗过，
 *  留下前导点（隐藏文件）或尾点（Windows 上会静默丢弃，且 ".." 形态有路径穿越风险）。 */
function stripEdgesToFixedPoint(s: string): string {
  let cur = s;
  // 有限次数兜底（每轮至少去掉一个字符才会继续，理论上不可能超）
  for (let guard = 0; guard < 256; guard++) {
    const next = cur.trim().replace(/^\.+/, '').replace(/\.+$/, '').trim();
    if (next === cur) return cur;
    cur = next;
  }
  return cur.trim();
}

/**
 * 把条目标题安全化为 `<标题>.md`（导出以便单测复用）：
 * 1) 删除 Cf 格式控制符（零宽、双向覆盖、BOM、软连字符）；
 * 2) `/ \ : * ? " < > |` 与控制字符（\p{Cc}）→ 空格；
 * 3) 压缩连续空白并 trim；
 * 4) **迭代**剥离首尾点与空白到不动点（防 ".."、隐藏文件、Windows 尾点）；
 * 5) 按码点截断到 80；截断后再清一次首尾点与空白；
 * 6) 空结果回退为 `untitled-<seed 短哈希>`；
 * 7) 撞上 Windows 保留设备名（按首段判定）前缀 `_`。
 */
export function safeFileName(title: string, seedId: string): string {
  const stripped = stripEdgesToFixedPoint(
    (title ?? '')
      .replace(FORMAT_CONTROL_CHARS, '')
      .replace(ILLEGAL_FILE_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  const cleaned = stripEdgesToFixedPoint(clampChars(stripped, FILE_NAME_MAX));
  const stem = cleaned || `untitled-${shortHash(seedId || title || 'feed-entry')}`;
  const firstSegment = stem.split('.')[0] ?? stem;
  return `${RESERVED_FIRST_SEGMENT.test(firstSegment) ? `_${stem}` : stem}.md`;
}

function buildMarkdown(feedTitle: string, entry: FeedEntry): string {
  const lines: string[] = [`# ${entry.title || '未命名条目'}`, ''];
  const meta: string[] = [];
  if (feedTitle) meta.push(`- 来源: ${feedTitle}`);
  if (entry.link) meta.push(`- 链接: ${entry.link}`);
  if (entry.publishedAt) meta.push(`- 发布时间: ${entry.publishedAt.toISOString()}`);
  if (meta.length) lines.push(...meta, '');
  const body = entryBody(entry);
  if (body) lines.push(body);
  return lines.join('\n');
}

// ---------------------------------------------------------------- 连接器

export const connectorRss: CloudConnector = {
  name: 'RSS',
  authType: 'apikey',

  async testConnection(config) {
    const cfg = validateConfig(config);
    if ('error' in cfg) return { success: false, message: cfg.error };
    try {
      const snapshot = await loadFeed(cfg.url);
      // 空源必须判失败：parseFeed 对「feed 形状但 0 条目」是合法返回空数组的，
      // 若这里报成功，用户会把"订阅地址填错 / 源站没内容"当成连接正常。
      // 计数一律用 snapshot.items.length（与 listFiles 同一口径），不看 feed.entries 原始长度。
      if (snapshot.items.length === 0) {
        const named = snapshot.title ? `（《${clipText(snapshot.title, CLIP_TITLE)}》）` : '';
        return {
          success: false,
          message: `该地址是合法 feed${named}，但当前没有任何条目，没有可同步的内容 —— 请确认订阅地址是否正确，或源站是否已发布内容`,
        };
      }
      return { success: true, message: `连接成功，共 ${snapshot.items.length} 条` };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '连接失败' };
    }
  },

  async listFiles(config, _parentId) {
    // RSS 无目录层级，parentId 一律忽略
    const url = requireUrl(config);
    const snapshot = await loadFeed(url);
    const files: CloudFile[] = [];
    for (const item of snapshot.items) {
      const { id, entry } = item;
      const body = entryBody(entry);
      files.push({
        id,
        name: safeFileName(entry.title, id),
        type: 'file',
        size: Buffer.byteLength(body, 'utf8'),
        mimeType: 'text/markdown',
        modifiedAt: entry.publishedAt,
        // 无 link 就**不写该字段**（绝不拿 feed 地址或标题编一个）。router 侧的口径是
        // `file.downloadUrl ?? ""`：查询键与落库值同为 ""（M-2 修的就是这里与那里的口径分叉），
        // 所以"缺字段"在下游等价于"没有原文链接"，不会变成 NULL 把去重打穿。
        ...(entry.link ? { downloadUrl: entry.link } : {}),
      });
    }
    return files;
  },

  async getContent(config, fileId) {
    const url = requireUrl(config);
    // 走缓存：sync 逐条调用时不会重复抓 feed（本方法最关键的性能约束）
    const snapshot = await loadFeed(url);
    const hit = snapshot.byId.get(fileId);
    if (!hit) return null;
    return {
      fileName: safeFileName(hit.entry.title, hit.id),
      mimeType: 'text/markdown',
      content: buildMarkdown(snapshot.title, hit.entry),
    };
  },

  async getDownloadUrl(config, fileId) {
    const url = requireUrl(config);
    const snapshot = await loadFeed(url);
    const hit = snapshot.byId.get(fileId);
    return hit?.entry.link || null;
  },

  /** RSS 是只读订阅源，没有"上传"概念。接口必须有返回值，这里诚实报失败（不假装成功、不发请求）。
   *  调用方若需写回，请改用网盘类连接器（alist / nas 等）。 */
  async uploadFile(_config, _fileName, _content) {
    return { success: false, path: '' };
  },

  /** 落盘同步语义对 feed 不成立（没有可下载的文件，正文要走 getContent 进 ingestion 流水线）。
   *  返回 { downloaded: 0, failed: 0 } 会被读成"同步成功但无文件"，属于误导，所以明确拒绝。
   *  RSS 入库请走 datasource-router.sync（type=rss）。 */
  async syncFiles(_config, _localPath) {
    throw new Error('RSS 为只读订阅源，不支持 syncFiles 落盘同步；请走数据源同步（datasource.sync）以 listFiles + getContent 拉取正文入库');
  },
};

registerConnector('rss', connectorRss);
