/**
 * Feed 解析模块（RSS 2.0 / RSS 1.0 RDF / Atom 三种根形态统一解析）
 * 独立于具体连接器，供 RSS 数据源接入复用。
 *
 * 设计要点：
 * - fast-xml-parser 以 preserveOrder 模式解析：保留文档顺序（混合内容不丢字）、
 *   属性隔离在 ':@' 节点（文本提取绝不读到属性值）、命名空间前缀原样保留
 *   （media:content 等不再与本地字段撞键），字段一律按本地名查找。
 * - media:* 等元数据命名空间显式排除，media:content 里的 URL 绝不可能被当成正文。
 * - type="xhtml" 的 title/content 结构是普通子元素树，文本提取自然递归进 <div>。
 * - 【标签形态只有一把尺子】（第四轮应修项 1）：isWellFormedMarkupAt() 是本模块判定
 *   "这一段是不是标记"的唯一谓词，stripMarkup 与测试不变式（findMarkupStart）共用它，
 *   绝不允许两套口径。尺子 = XML 语法的 well-formed 标记：
 *     `<` /? NAME (WS attr=QUOTED|BARE)* WS? /? >，或 <!-- -->、<![...]>、<?...?>
 *   其中 NAME 只接受 ASCII 字母数字与 . - _ : #（`<1abc>` `<_x>` `<#if a==b#>` 这类
 *   伪标签同样是标记形态，必须与真标记一样剥净，否则输出留着能同时骗过两边的脏 token）。
 *   属性必须带 `=`：`a<b and c>d`、`参数 a<max 且 b>min` 里的 `<b and c>` / `<max 且 b>`
 *   不满足语法 → 按作者本意的字面文本保留（缺陷 N5：句子不能被剥坏）。
 *   跨度上限 MAX_MARKUP_SPAN：超过它就不当标记（防止 `<b` + 50KB 正文 + `>` 把整段
 *   正文静默吞掉；尺子两边同界，所以"留下"与"断言"依然一致）。
 * - 实体只解【已知】的（HTML_NAMED + 数字型）；未知实体（如 &fjorde;）保守保留原文。
 * - 【两把清洗口径，刻意分开】（第四轮 M-C 定稿）：
 *   · 散文出口 title / content / summary —— toPlainText：元素之间【补一个分隔空格】
 *     （防 "AlphaBeta" 粘连），C0/DEL 换成空格（同一条理由）。
 *   · 标识符出口 id / link —— toIdentifierText：解实体 → 剥标签但【不插】分隔符 →
 *     删除 C0/DEL/零宽 → 折叠空白 → trim。它们是标识符不是散文：
 *     `<guid>tag:x<b>1</b></guid>` 的语义就是 tag:x1，给它插空格等于给同一条目换主键。
 *     ⚠️ 迁移窗口：RSS 功能尚未上线，现在定口径没有历史数据要迁；一旦上线后再改这套
 *     规则，所有已入库条目的 id 都会变 → 下游按 id 判为新条目 → 全量重复入库。
 *     所以口径由测试逐条钉死（实体解码 / 剥标签不插分隔 / 空白折叠 / 控制符删除），
 *     后人"顺手把两套口径统一"必然变红。
 * - 容错：真实世界 feed 常见游离裸 &（如 URL 里 ?a=1&b=2），解析前规范为 &amp;；
 *   feed 形状但语法有瑕疵 → MalformedXMLError；根标签不对 → NotAFeedError。
 *   两者都可判别抛出，绝不静默吞掉。
 * - 空源契约：feed 形状但 0 条目是【合法返回】（{ title, entries: [] }），
 *   调用方（连接器层）须自行判定空源；本模块只在"根本不是 feed"时抛错。
 * - 【体积预算按实际要解析的串计】（第四轮 M-A）：MAX_FEED_INPUT_BYTES（8 MiB）先按
 *   原始输入做快速拒绝（超大原始输入绝不为规范化而先读进来），再在裸 & 规范化的【过程中】
 *   累计输出字节并在越界时立即中止——规范化是 1→5 倍放大（`&` → `&amp;`），只按"进来的
 *   串"计上限，等于给了 5 倍绕过口子（8MiB 裸 & 输入会放大成 40MB 进解析器，2C 宿主上
 *   十秒级单线程阻塞，正是上限要防的那类事）。
 * - 条目取舍（第四轮 M-B）：身份判据 = guid / id / rdf:about / dc:identifier /
 *   enclosure url 中【存在且取到非空值】的那一个；时间字段（pubDate/date/published/
 *   updated）一律不算身份。id 为空且 title/link/content/summary 全空 → 过滤，
 *   绝不再批量产出空 id 条目（下游按空 id 入库会互相覆盖）。
 * - 条目收集：RSS 2.0 与 RDF 都遍历【全部】 channel（第四轮应修项 3：只取第一个 channel
 *   会把第二个 channel 的整批条目丢掉），RDF 另收根下 item；同一 id 只保留一条
 *   （应修项 2：按解析后的 id 去重才是有意义的判据，节点对象身份永不碰撞）。
 * - 同 id 合并 = 【字段并集】（第五轮 M-E）：旧实现是覆盖式替换，"A 只有 description +
 *   B 只有 title/pubDate"这类互补条目会静默丢字段（实测 title="" / publishedAt=undefined）。
 *   现在以"更完整"的一条为底（覆盖数 → 正文体量 → 先出现者，量化规则见 completeness 注释），
 *   把落选方的非空出口补进底的空位；两边都非空的冲突字段一律取底（不逐字段混挑，
 *   避免伪造出源站从未提交过的混合条目）。RSS / RDF / Atom 三个分支都走同一份 dedupeById
 *   （Atom 分支曾漏调用 = 整段零断言覆盖洞）。
 * - feed.title（第五轮 M-H）：RSS/RDF 既然遍历了全部 channel，频道标题也按同一口径取
 *   文档顺序里【第一个非空】的 channel title，不再"只看第一个 channel，它没名字就给空串"。
 * - 元素/标记边界处的分隔符（第五轮 M-D）：边界【延迟结算】且【标点感知】——
 *   词边界多插一个空格可以接受（宁可多切不可粘连，插空格永不改变词序），
 *   但紧邻标点时不插：`<em>term</em>.` 必须是 "term."，不能剥成 "term ."
 *   （标点被撑成独立 token 会同时伤害短语匹配与中文分词）。
 */

import { XMLParser } from "fast-xml-parser";

export interface FeedEntry {
  /** 身份兜底链：guid / id → link → rdf:about → dc:identifier → enclosure url → title
   *  （值一律走 toIdentifierText 紧凑清洗口径） */
  id: string;
  title: string;
  link: string;
  /** 解析失败则不设置该字段（不抛错） */
  publishedAt?: Date;
  /** 纯文本 */
  summary: string;
  /** 纯文本 */
  content: string;
}

export interface ParsedFeed {
  title: string;
  entries: FeedEntry[];
}

/** 非 feed 输入（根标签不是 rss / rdf:RDF / feed）的可判别错误 */
export class NotAFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAFeedError";
  }
}

/** 是 feed 形状但 XML 有语法瑕疵（如截断、非法字符）的可判别错误 */
export class MalformedXMLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedXMLError";
  }
}

/** 输入超过体积上限 */
export class FeedInputTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedInputTooLargeError";
  }
}

/** 输入体积上限（UTF-8 字节口径，8 MiB）。
 *  上限的本意是【内存/时间预算】，预算天然按字节算：按字符数会随文字系统漂移
 *  （ASCII 源能用满 8MB，CJK 源只许用 1/3），且旧实现只看 xml.length 时 CJK feed
 *  在 8M 字符处实际约 24MB UTF-8（实测约 2.5s / Δheap +145MB），会拖垮 2C/7.6G 常驻服务。
 *  第四轮 M-A 补上的下半句：预算必须按【实际交给解析器的那串】计——裸 & 规范化会把
 *  每个 `&` 放大 5 倍，所以字节校验分两道：原始输入前置拒绝（尽早，不为规范化读入超大串）
 *  + 规范化过程中累计输出字节复检（放大越界同样拒绝）。
 *  为把最坏情况的计数成本也按住，保留字符数上限 MAX_FEED_INPUT_CHARS 作为【前置快速拒绝】
 *  （字节数 >= 字符数，字符数已超限者不必再数字节）。 */
export const MAX_FEED_INPUT_BYTES = 8 * 1024 * 1024;
/** 字符数前置快速拒绝上限（见 MAX_FEED_INPUT_BYTES 的说明） */
export const MAX_FEED_INPUT_CHARS = 8 * 1024 * 1024;

/** UTF-8 字节长度（不依赖 Buffer/TextEncoder，纯字符串扫描；代理对按 4 字节计，
 *  孤立代理项按 3 字节计——与 Buffer.byteLength(s, "utf8") 逐单位精确对齐，
 *  测试按单位类型 + 边界逐个钉住，防止 ±1 字节漂移把上限口径悄悄改掉）。
 *  导出仅供测试与调用方核对口径。 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3; // 孤立代理项：编码层会替换成 U+FFFD（3 字节），按 3 字节计
      }
    } else bytes += 3;
  }
  return bytes;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

/** preserveOrder 模式节点：元素为 { [tag]: children, ':@'?: attrs }，文本为 { '#text': string } */
type OrderNode = Record<string, unknown>;

function isNode(v: unknown): v is OrderNode {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 元素节点的标签键（'#text' 文本节点等返回 undefined） */
function tagOf(node: OrderNode): string | undefined {
  for (const key of Object.keys(node)) {
    if (key !== ":@" && key !== "#text") return key;
  }
  return undefined;
}

function childrenOf(node: OrderNode): OrderNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const v = node[tag];
  if (!Array.isArray(v)) return isNode(v) ? [v] : [];
  return v.filter(isNode);
}

function attrOf(node: OrderNode, name: string): string | undefined {
  const at = node[":@"] as Record<string, unknown> | undefined;
  if (!at) return undefined;
  const v = at[`@_${name}`] ?? at[name];
  return typeof v === "string" ? v : undefined;
}

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i === -1 ? tag : tag.slice(i + 1);
}

function prefixOf(tag: string): string {
  const i = tag.indexOf(":");
  return i === -1 ? "" : tag.slice(0, i);
}

/** 这些命名空间是媒体/链接元数据，绝不可参与正文/标题/时间等字段查找 */
const METADATA_PREFIXES = new Set(["media"]);

/**
 * 结构标签判定（本地名口径）：rss / rdf:RDF / feed 的根判定、entry / item / link /
 * channel 的结构判定必须【同一套口径】，否则出现「detectRoot 认得 atom:feed 当根，
 * 条目循环却不认 atom:entry」这类条目全丢的回归（缺陷 N1a/N1b）。
 * 元数据前缀（media:*）一律排除：media:content / media:description 等绝不冒充字段或结构标签。
 */
function isTag(node: OrderNode, local: string): boolean {
  const tag = tagOf(node);
  if (!tag) return false;
  const prefix = prefixOf(tag);
  if (prefix && METADATA_PREFIXES.has(prefix)) return false;
  return localName(tag) === local;
}

/* ---------------- 元素/标记边界处的分隔符（散文出口口径，两条路径共用） ---------------- */

/** 边界之后紧跟着出现的字符是否属于"不该在它前面插分隔符"的一类。
 *  判据（第五轮 M-D，复核给出并采纳）：
 *   - 空白：插了也会被 \s+ 归一掉，不重复补。
 *   - 标点/符号（Unicode P* 与 S*，含全角 ，。、（） 与 ASCII , . ; ! ? ( ) 等）：
 *     在词与标点之间插空格会把标点从词上剥下来变成独立 token（"term ."、"见 粗体 ，后文"），
 *     直接伤害短语匹配与中文分词 ⇒ 不可接受。
 *  与之相对，词边界处的多插（"word bold"）是【可接受】的代价：宁可多切不可粘连，
 *  插空格永远不改变词序，比误删/粘连安全。
 *  （用属性类而不是手写 ASCII 表：一个正则测一个字符，代价可忽略，覆盖全角/其它文字的标点，
 *  不需要为每种文字维护清单。） */
function isGlueChar(ch: string): boolean {
  return /[\s\p{P}\p{S}]/u.test(ch);
}

/** 该在边界处补分隔符吗：确有边界 + 底非空且不以空白收尾（canAppend）+ 下一段不以粘合字符开头。
 *  ⚠️ 判据以【布尔量】传入而不是拿 out 去跑正则：`/\s$/.test(out)` 会把 V8 的 cons-string
 *  （`out += chunk` 的惰性拼接）就地摊平，逐点摊平就是 O(n²)——
 *  实测 2MB 密集孤立 `<` 输入因此从线性掉到 3.2s。调用方自己维护 lastChar 即可 O(1) 判定。 */
function shouldInsertSep(pending: boolean, sep: string, canAppend: boolean, nextChunk: string): boolean {
  return pending && !!sep && canAppend && !!nextChunk && !isGlueChar(nextChunk[0]);
}

/** out 是否"非空且不以空白结尾"（配合 lastChar 做 O(1) 判定） */
function canTakeSep(out: string, lastChar: string): boolean {
  return out !== "" && !/\s/.test(lastChar);
}

/**
 * 文档顺序拼接节点的全部文本（含后代文本，混合内容不丢字）。
 * 只读 #text 与后代元素文本，绝不读属性（属性在 ':@' 中，天然隔离）。
 * sep 为元素边界【两侧】补的分隔符（缺陷 N6 + 第四轮应修项 4 + 第五轮 M-D）：
 *  - 散文出口传 " "：`<p>Alpha</p><p>Beta</p>` → "Alpha Beta"，与标记剥离路径
 *    （stripMarkup 在每个标记位置留一个边界）【完全同口径】——旧版只在前侧补，于是
 *    `A<b>B</b>C` → "A BC"、`<p>A</p>Beta` → "ABeta"，同一段 HTML 走 CDATA 与走
 *    结构两条路得到不同结果，属实现分裂。现在两侧都留边界，两侧对称。
 *  - 边界是【延迟结算】的（pendingBoundary）：先记下"这里有个边界"，等下一段文本到手再决定
 *    插不插（见 shouldInsertSep）。旧实现是"闭合侧无条件补"，于是 `</em>` 后面的句号被
 *    撑成 "term ."（M-D 回退）。空元素同样留下边界：`A<br/>B` → "A B"（旧版给 "AB"）。
 *  - 元素节点起点【永远】是一个边界（等价于标记路径上那个开标签留下的边界）；文本节点
 *    不产生边界，只结算已有边界。结算为"粘合不插"时边界同样被消费掉，后一个元素自带
 *    新边界（`<span>1</span>,<span>2</span>` → "1, 2"：逗号粘住，逗号之后照常分隔）。
 *  - 标识符出口传 ""：元素之间不插任何分隔（M-C 紧凑口径）；sep="" 时本函数等价于纯拼接
 *    （shouldInsertSep 对空 sep 恒为 false，末尾悬空边界也不结算）。
 *  归一只作用于【本函数自己的产出】：#text 节点原样参与拼接，实体与标记由
 *  toPlainText / toIdentifierText 的迭代循环处理，顺序与口径都在那里定。
 */
function textOfNodes(nodes: OrderNode[], sep = " "): string {
  let out = "";
  let lastChar = "";
  let pendingBoundary = false;
  const append = (chunk: string) => {
    if (!chunk) return;
    out += chunk;
    lastChar = chunk[chunk.length - 1];
  };
  for (const node of nodes) {
    const text = node["#text"];
    if (typeof text === "string") {
      if (shouldInsertSep(pendingBoundary, sep, canTakeSep(out, lastChar), text)) append(sep);
      if (text) pendingBoundary = false;
      append(text); // 原样拼接（不 trim）：trim 会造出假边界，也改变实体/标记的相邻性
      continue;
    }
    const inner = textOfNodes(childrenOf(node), sep);
    if (shouldInsertSep(true, sep, canTakeSep(out, lastChar), inner)) append(sep); // 元素起点是边界
    append(inner);
    if (sep) pendingBoundary = true; // 元素终点是边界（空元素同样留下）
  }
  // 末尾悬空边界结算为分隔符，让相邻两次 textOfNodes 的拼接也拿到边界
  if (sep && pendingBoundary && canTakeSep(out, lastChar)) out += sep;
  return sep ? out.replace(/\s+/g, " ") : out;
}

/** 按本地名查字段：先取无前缀精确匹配，再取带前缀匹配（media:* 等元数据前缀除外） */
function findField(nodes: OrderNode[], local: string): OrderNode | undefined {
  for (const node of nodes) {
    if (tagOf(node) === local) return node;
  }
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) continue;
    const prefix = prefixOf(tag);
    if (prefix && !METADATA_PREFIXES.has(prefix) && localName(tag) === local) return node;
  }
  return undefined;
}

function findFirst(nodes: OrderNode[], locals: string[]): OrderNode | undefined {
  for (const local of locals) {
    const hit = findField(nodes, local);
    if (hit) return hit;
  }
  return undefined;
}

/** 散文出口的字段文本 */
function fieldText(nodes: OrderNode[], locals: string[]): string {
  const el = findFirst(nodes, locals);
  return el ? textOfNodes(childrenOf(el), " ") : "";
}

/** 标识符出口的字段文本：元素之间【不插】分隔符，其余交给 toIdentifierText */
function identifierFieldText(nodes: OrderNode[], locals: string[]): string {
  const el = findFirst(nodes, locals);
  return el ? textOfNodes(childrenOf(el), "") : "";
}

/** 按本地名取【全部】同名节点（无前缀优先，再带前缀；元数据前缀除外），文档顺序 */
function collectFields(nodes: OrderNode[], local: string): OrderNode[] {
  const exact: OrderNode[] = [];
  const prefixed: OrderNode[] = [];
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) continue;
    const prefix = prefixOf(tag);
    if (prefix && METADATA_PREFIXES.has(prefix)) continue;
    if (localName(tag) !== local) continue;
    (prefix ? prefixed : exact).push(node);
  }
  return exact.concat(prefixed);
}

/** 属性按本地名取（rdf:about 这类带前缀属性也能取到；空值视为无） */
function attrByLocal(node: OrderNode, local: string): string {
  const at = node[":@"] as Record<string, unknown> | undefined;
  if (!at) return "";
  const direct = at[`@_${local}`] ?? at[local];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const [k, v] of Object.entries(at)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const name = k.startsWith("@_") ? k.slice(2) : k;
    if (localName(name) === local) return v.trim();
  }
  return "";
}

/** 取第一个非空 enclosure url（播客纯音频条目唯一的身份源，缺陷 N4） */
function enclosureUrl(nodes: OrderNode[]): string {
  for (const el of collectFields(nodes, "enclosure")) {
    const url = attrByLocal(el, "url");
    if (url) return url;
  }
  return "";
}

/* ---------------- HTML 命名实体 ---------------- */

/** 含 5 个 XML 预定义实体：feed 的典型场景是 HTML 双层转义嵌在 XML 里
 *  （源写 &amp;amp;，XML 解析一层后剩 &amp;），本模块再解一层（单次解码语义）。
 *  导出仅供测试整表遍历钉口径（旧版只枚举 14/33 项，删掉 euro/lsquo/deg 无人察觉）。 */
export const HTML_NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  iexcl: "¡",
  cent: "¢",
  pound: "£",
  sect: "§",
  copy: "©",
  laquo: "«",
  reg: "®",
  deg: "°",
  plusmn: "±",
  middot: "·",
  raquo: "»",
  frac14: "¼",
  frac12: "½",
  frac34: "¾",
  times: "×",
  divide: "÷",
  ndash: "–",
  mdash: "—",
  permil: "‰",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  dagger: "†",
  hellip: "…",
  euro: "€",
  trade: "™",
};

function decodeOneEntity(g1: string, rawMatch: string): string {
  if (g1.startsWith("#")) {
    // g1 形如 "#x200B"（含 # 前缀）：先去掉 #，再看是否 x/X 前缀的十六进制
    const digits = g1.slice(1);
    const code = /^[xX]/.test(digits) ? parseInt(digits.slice(1), 16) : parseInt(digits, 10);
    if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return rawMatch;
      }
    }
    return rawMatch;
  }
  return HTML_NAMED[g1.toLowerCase()] ?? rawMatch;
}

function decodeEntitiesOnce(s: string): string {
  return s.replace(/&([a-zA-Z][a-zA-Z0-9]*|#[xX]?[0-9a-fA-F]+);/g, (m, g1) => decodeOneEntity(g1, m));
}

/* ---------------- 标签形态的唯一尺子（实现与测试共用） ---------------- */

/** 标记名 / 属性名的长度上限（第五轮 item5 引入的分界）。
 *  旧实现只有一条"整段跨度 ≤ 4096"的闸门，代价是【确实是标签、只是属性值很长】的东西
 *  （data URI 图片、超长 URL）不再被当标签 —— 复核实测：`<img src="data:image/png;base64,{5000}">`
 *  把 5039 字 base64 整段泄漏进 content。正确的分界不是总跨度，而是【名字】：
 *   - 名字超长（`HEAD<b` + 50KB 正文 + `>` 那种）几乎必然是散文 ⇒ 按名字长度挡住，正文不被吞掉；
 *   - 名字正常、只是值很长 ⇒ 是标签 ⇒ 标签体整体剥掉，不进正文。
 *  256 的取值依据：三个真实固件里 306 字符是【整段标签】（nature 的 `<a href=…>`）而不是名字，
 *  名字本身都在 30 字内；自定义元素（`<my-component>`）加长命名空间前缀也极少超过 60 字。
 *  256 留了约一个数量级余量，又远小于"整段散文"的尺度，正好卡在两者之间。 */
export const MAX_MARKUP_NAME_LEN = 256;

/** 注释 `<!-- -->`、声明 `<![ ]>` / `<? ?>` 的跨度上限（第四轮取值 4096，本轮不改其方向）：
 *  这三类吃掉的是【体】（可能就是正文），所以仍按 4096 设界；标签类的界见上面两条 + 下面的绝对上限。
 *  ⚠️ 尺子两侧（stripMarkup / findMarkupStart）共用同一组常数，所以"因超长而留下"的文本
 *  同样不会被不变式判成残留 —— 但"留下"不等于"正确"，测试还有一把【独立宽尺】兜底（见测试文件）。 */
export const MAX_MARKUP_SPAN = 4096;

/** 单段标签的绝对跨度上限（第五轮 item5：长标签不再受 4096 限制，但不能没有上限）。
 *  取值依据：总预算由 8MiB 的输入上限把住，这里只管【单个标签能有多大】。现实最大的一档是
 *  内联 data URI（图片 / 字体），公开样本在几百 KB 内 ⇒ 1 MiB 留 2~3 倍余量；
 *  同时把"单点判定的最坏扫描代价"钉在 1 MiB 以内，配合 ctx 的
 *  【全串再无 '>' / 再无同类引号 ⇒ 立即判散文】快退，病态输入不退化成二次方
 *  （实测见测试"病态长输入线性"与交付报告：2MiB 病态串数十毫秒量级）。
 *  超过 1 MiB 的"标签"按散文保留 —— 宁可留下字面文本，也不冒吞掉整段正文的风险。 */
export const MAX_MARKUP_ABSOLUTE_SPAN = 1024 * 1024;

/** HTML void 元素：规范上【不存在】闭合标签，所以"全串找不到闭合"对它们不构成散文证据。
 *  散文守卫（下面的泛型/比较守卫）对名单内的名字一律不适用，否则真实 feed 里
 *  `文字<br>x`、`文字<hr>y` 这类会留下残留标记。 */
const HTML_VOID_NAMES = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** 标签名/属性名【后续】字符可接受：ASCII 字母数字 + . - _ : #
 *  （数字仍可出现在名字里，只是不能打头 —— 见 isMarkupStartChar；
 *  非 ASCII 不进名字，`<max 且 b>` 因此不会被误判为标签） */
function isMarkupNameChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    (c >= 0x30 && c <= 0x39) || // 0-9
    c === 0x2e || // .
    c === 0x2d || // -
    c === 0x3a || // :
    c === 0x5f || // _
    c === 0x23 // #
  );
}

/** 名字【首】字符：只允许 ASCII 字母与 _ : #，数字被打发掉（第五轮 M-G）。
 *  为什么这么定：XML/HTML 的 NameStartChar 本来就不接受数字开头，"数字开头的标签"在现实
 *  feed 里不出现；而 `1<2>0`、`std::vector<int>`、`List<T>` 是代码类/技术类 feed 的常态内容。
 *  两害相权：挡住数字开头既能救下数学比较，也让 `<1abc>` 这类伪标签变成"可辩护的字面保留"
 *  （行为变化已在测试里显式登记）。`_` 与 `#` 保留作首字符，是为了继续剥净 `<_x>`、
 *  `<#if a==b#>` 这类模板/伪标签。`.` 与 `-` 不作首字符（同 XML 口径，且现实中无此类标签）。 */
function isMarkupStartChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    c === 0x3a || // :
    c === 0x5f || // _
    c === 0x23 // #
  );
}

/** '<' 前一个字符是否属于"标识符/数字"（泛型守卫的证据之一：`a<b>`、`vector<int>`、`1<2>`
 *  都是紧贴标识符的 '<'，而真标签前面通常是空白、'>'、'< ' 或串首）。
 *  用 Unicode 字母/数字而不是 ASCII：中文正文里 `文字<b>c` 同样是"紧贴词后"的比较形态语义。 */
function isWordCharBeforeLt(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

function isMarkupSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** 尺子的扫描上下文（第五轮：去掉 4096 跨度上限后，靠它把代价重新按住线性）。
 *  - closeNames：全串出现过的闭合标签名（小写本地名）。泛型守卫要问"这段有没有闭合证据"，
 *    逐标签 `indexOf` 会退化成 O(标签数 × n)；这里一次正则建表 ⇒ O(n) 建表 + O(1) 查询。
 *  - lastGt / lastDoubleQuote / lastSingleQuote：全串最后一个 '>' / 引号的位置。
 *    判定过程中一旦越过它们，就不可能再闭合 ⇒ 立即返回 -1，
 *    避免"每个孤立 '<' 都扫满 1MiB"的病态放大。 */
export interface MarkupScanContext {
  closeNames: Set<string>;
  lastGt: number;
  lastDoubleQuote: number;
  lastSingleQuote: number;
}

const CLOSE_TAG_NAME = /<\/([a-z_:#][a-z0-9_.:-]*)/gi;

/** 为一次扫描建上下文（同一条串反复判定时务必复用；单次调用 O(n)） */
export function createMarkupScanContext(s: string): MarkupScanContext {
  const closeNames = new Set<string>();
  CLOSE_TAG_NAME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOSE_TAG_NAME.exec(s)) !== null) closeNames.add(localName(m[1].toLowerCase()));
  return {
    closeNames,
    lastGt: s.lastIndexOf(">"),
    lastDoubleQuote: s.lastIndexOf('"'),
    lastSingleQuote: s.lastIndexOf("'"),
  };
}

/**
 * 【唯一谓词】：s[i] === '<' 时判断这里是否开启一段 well-formed 标记，是则返回结束位置
 * （'>...' 之后第一个下标），否则返回 -1。实现（stripMarkup）与断言（findMarkupStart）
 * 共用它 —— 绝不允许两套口径。
 * 语法：注释 `<!--...-->`、声明 `<![...]>` / `<?...?>`、标签 `</?NAME (attr=VALUE)* /?>`。
 * 三条判据（第五轮）：
 *  1. 名字首字符必须是字母 / _ / : / #（数字不行，M-G）；名字与属性名长度 ≤ MAX_MARKUP_NAME_LEN。
 *  2. 属性形态：`name=` 值 是硬要求，但【至多 1 个裸属性名】仍判为标记（M-F：布尔属性
 *     `<input readonly>`、`<td nowrap bgcolor="red">` 是真实老式 HTML 的常态）；
 *     出现第 2 个裸属性名就与散文无法区分 ⇒ 判散文（`a<b and c>d`、`x <a href=x y z>y` 保住）。
 *  3. 标签总跨度不设 4096 上限（长 data URI 必须能剥掉），只设 MAX_MARKUP_ABSOLUTE_SPAN。
 * 泛型/比较守卫（M-G 的第二半，只在【四个条件同时成立】时把标签判为散文）：
 *  非闭合标签 + 零属性 + 非自闭合 + '<' 紧贴标识符字符 + 该名字在全串【没有任何闭合证据】
 *  + 不在 HTML void 名单内 ⇒ 判散文。
 *  这条守卫救的是 `变量 a<b>c 时`、`std::vector<int>`、`List<T>`：它们与 `word<b>bold</b>`
 *  的唯一区别就是"源里到底有没有 </b>"，所以证据取自闭合标签名集合，代价由 ctx 一次性建表按住。
 *  已知代价：`文字<div>`（非 void、紧贴词、全串无闭合）会被当散文留下 —— 这种写法在真实
 *  HTML 里等于标签本身没写完，宁可留残留也不吞正文；独立宽尺会把这类残留抓出来。
 * 导出给测试做不变式断言用；批量扫描请传 ctx（单次调用不带 ctx 时本函数自建，O(n)）。
 */
export function isWellFormedMarkupAt(s: string, i: number, ctx?: MarkupScanContext): number {
  if (s[i] !== "<") return -1;
  const c = ctx ?? createMarkupScanContext(s);
  const commentLimit = i + MAX_MARKUP_SPAN;
  const absLimit = Math.min(s.length, i + MAX_MARKUP_ABSOLUTE_SPAN);

  if (s.startsWith("<!--", i)) {
    const end = s.indexOf("-->", i + 4);
    return end === -1 || end + 3 > commentLimit ? -1 : end + 3;
  }
  if (s.startsWith("<!", i)) {
    // CDATA / DOCTYPE / 其它 <! 声明：吃到第一个 '>'（与既有实现同口径）
    const gt = s.indexOf(">", i + 2);
    return gt === -1 || gt + 1 > commentLimit ? -1 : gt + 1;
  }
  if (s[i + 1] === "?") {
    const close = s.indexOf("?>", i + 2);
    if (close !== -1 && close + 2 <= commentLimit) return close + 2;
    const gt = s.indexOf(">", i + 2);
    return gt === -1 || gt + 1 > commentLimit ? -1 : gt + 1;
  }

  // 全串在这之后再也没有 '>' ⇒ 标签不可能闭合，立刻判散文（防病态输入逐点扫满绝对上限）
  if (c.lastGt <= i) return -1;

  let j = i + 1;
  const closing = s[j] === "/";
  if (closing) j++;
  const nameStart = j;
  if (!isMarkupStartChar(s[j])) return -1; // 数字开头 / 非 ASCII / `< ` / `<<` 都不是合法名字
  j++;
  while (j < absLimit && isMarkupNameChar(s[j])) j++;
  const nameLen = j - nameStart;
  if (nameLen > MAX_MARKUP_NAME_LEN) return -1; // 超长"名字"：几乎必然是散文，不许吞正文
  const name = localName(s.slice(nameStart, j).toLowerCase());

  let attrCount = 0;
  let bareNameCount = 0;
  let selfClosing = false;
  for (;;) {
    while (j < absLimit && isMarkupSpace(s[j])) j++;
    if (j >= absLimit) return -1;
    if (s[j] === ">") {
      j++;
      break;
    }
    if (s[j] === "/") {
      if (s[j + 1] !== ">") return -1; // 标签内出现单个 '/'（`<a href=a/b>` 由裸值吃掉）
      selfClosing = true;
      j += 2;
      break;
    }
    const attrStart = j;
    if (!isMarkupStartChar(s[j])) return -1; // 裸词/非法字符开头不是属性名
    j++;
    while (j < absLimit && isMarkupNameChar(s[j])) j++;
    if (j - attrStart > MAX_MARKUP_NAME_LEN) return -1;
    while (j < absLimit && isMarkupSpace(s[j])) j++;
    attrCount++;
    if (s[j] !== "=") {
      // 裸属性名（布尔属性）：至多 1 个还判标记，第 2 个起判散文（M-F）
      bareNameCount++;
      if (bareNameCount > 1) return -1;
      continue;
    }
    j++;
    while (j < absLimit && isMarkupSpace(s[j])) j++;
    const quote = s[j];
    if (quote === '"' || quote === "'") {
      const floor = quote === '"' ? c.lastDoubleQuote : c.lastSingleQuote;
      if (j >= floor) return -1; // 全串再无同类引号 ⇒ 永不闭合，快退
      const close = s.indexOf(quote, j + 1);
      if (close === -1 || close > absLimit) return -1;
      j = close + 1;
    } else {
      const valueStart = j;
      while (
        j < absLimit &&
        !isMarkupSpace(s[j]) &&
        s[j] !== ">" &&
        s[j] !== '"' &&
        s[j] !== "'"
      )
        j++;
      if (j === valueStart) return -1;
    }
    if (j >= absLimit) return -1;
  }

  // 泛型/比较守卫（见函数注释第 3 段）
  if (
    !closing &&
    !selfClosing &&
    attrCount === 0 &&
    i > 0 &&
    isWordCharBeforeLt(s[i - 1]) &&
    !HTML_VOID_NAMES.has(name) &&
    !c.closeNames.has(name)
  )
    return -1;

  return j;
}

/** 文本里第一段 well-formed 标记的起点；-1 表示没有。测试的标签形态不变式只用它。
 *  上下文一次建好传给谓词（O(n) 建表 + 逐点 O(1) 查询），绝不能在循环里逐点重建。 */
export function findMarkupStart(s: string): number {
  const ctx = createMarkupScanContext(s);
  for (let i = s.indexOf("<"); i !== -1; i = s.indexOf("<", i + 1)) {
    if (isWellFormedMarkupAt(s, i, ctx) !== -1) return i;
  }
  return -1;
}

/** 已匹配到的标记是否为 script/style 的【开标签】（整块要连同 JS/CSS 正文一起吞掉，缺陷 N3） */
function blockTagName(s: string, start: number, end: number): string | null {
  if (s[start + 1] === "/") return null; // 闭合标签
  if (s.slice(end - 2, end) === "/>") return null; // 自闭合：块内无正文
  let j = start + 1;
  while (j < s.length && isMarkupNameChar(s[j])) j++;
  const raw = s.slice(start + 1, j).toLowerCase();
  const name = localName(raw);
  return name === "script" || name === "style" ? name : null;
}

/**
 * 线性扫描剥标记（O(n)，防大输入下正则回溯拖垮 2C 常驻服务）：只吃 isWellFormedMarkupAt
 * 认下的片段，其余 '<' 一律按字面文本保留（见尺子注释，缺陷 N5）。
 * - 注释块 <!--...--> 连同内容丢弃
 * - <script>/<style> 块连同标签之间的 JS/CSS 正文丢弃；开闭标签【大小写都不敏感】
 *   （缺陷 N3：旧实现用原大小写的开标签名去 lower() 过的串里找闭合，`<SCRIPT>` 永远
 *   找不到 → 退化成"按普通标签吃到 >"，JS/CSS 正文泄漏进"纯文本"）
 * - sep 决定标记位置留什么：散文口径 " "（与 textOfNodes 同口径，边界延迟结算 +
 *   标点感知，见 shouldInsertSep / isGlueChar），标识符口径 ""（不插）
 * 已知可辩护取舍：`<script>` / `<style>` 开了却【全串无闭合】时，按普通标签只吃掉开标签
 * 本身（残留的 JS/CSS 留在文本里）；`<` 后是标记形态但跨度超 MAX_MARKUP_SPAN 时整段留作
 * 字面文本。两种残留都不违反不变式——尺子只有一把，实现与断言同时认它。
 */
function stripMarkup(s: string, sep: string): string {
  const lower = s.toLowerCase();
  const ctx = createMarkupScanContext(s); // 一次建表，逐点复用（O(n)），绝不在循环里重建
  const missingCloses = new Set<string>(); // 已确认全串不存在的闭合块名（小写），避免逐块全串搜索退化为 O(n²)
  let out = "";
  let lastChar = "";
  let pendingBoundary = false;
  const emit = (chunk: string) => {
    if (!chunk) return;
    if (shouldInsertSep(pendingBoundary, sep, canTakeSep(out, lastChar), chunk)) out += sep;
    pendingBoundary = false;
    out += chunk;
    lastChar = chunk[chunk.length - 1];
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      emit(s.slice(i));
      break;
    }
    emit(s.slice(i, lt));
    const end = isWellFormedMarkupAt(s, lt, ctx);
    if (end === -1) {
      // 不是 well-formed 标记：'<' 按作者本意的字面文本保留
      out += "<";
      lastChar = "<";
      i = lt + 1;
      continue;
    }
    const block = blockTagName(s, lt, end);
    if (block && !missingCloses.has(block)) {
      const closeAt = lower.indexOf(`</${block}`, end);
      if (closeAt === -1) {
        // 开了没关的块：按普通标签处理，只吃掉开标签本身（可辩护取舍，见函数注释）
        missingCloses.add(block);
        i = end;
      } else {
        const closeGt = s.indexOf(">", closeAt);
        i = closeGt === -1 ? n : closeGt + 1;
      }
      pendingBoundary = true;
      continue;
    }
    i = end;
    pendingBoundary = true; // 每个标记留一个边界，插不插由下一段文本决定（M-D）
  }
  // 末尾悬空边界结算：与 textOfNodes 同口径（散文出口随后还会 \s+ 归一 + trim）
  if (sep && pendingBoundary && canTakeSep(out, lastChar)) out += sep;
  return out;
}

/**
 * 散文出口（title / content / summary）的纯文本清洗：
 * 迭代「剥标记 → 解一层实体」直到不动点（≤4 轮有界，防构造攻击）。
 * 收尾：零宽字符删除；C0 控制字符与 DEL 换成【空格】（缺陷 N9）——换空格而不是删，
 * 是为了不造出 "alphabeta" 这类粘连脏 token（与 N6 同一条理由）；
 * \t\n\r\v\f 属空白类，交给后面的 \s+ 归一。孤立 '<'（无 > 闭合）按字面保留。
 */
function toPlainText(raw: string): string {
  let s = raw;
  for (let round = 0; round < 4; round++) {
    const next = decodeEntitiesOnce(stripMarkup(s, " "));
    if (next === s) break;
    s = next;
  }
  return s
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 标识符出口（id / link）的紧凑清洗：解实体 ↔ 剥标签（元素之间【不插】分隔符）迭代到
 * 不动点（≤4 轮）→ 删零宽 → 【删除】C0/DEL → 折叠空白为单空格 → trim。
 * 与散文口径的两处刻意差别（不要"顺手统一"，测试已逐条钉死）：
 *  1. 不插分隔符：`<guid>tag:x<b>1</b></guid>` 的语义就是 tag:x1；补空格会让同一条目换主键。
 *  2. 控制符删除而非换空格：正文换空格是防粘连，标识符换空格会把一个 URL 劈成两段。
 * ⚠️ 上线后改这套规则 = 全量条目被判新条目重复入库。现在（功能未上线）是唯一定口径窗口。
 */
function toIdentifierText(raw: string): string {
  if (!raw) return "";
  let s = raw;
  for (let round = 0; round < 4; round++) {
    const next = decodeEntitiesOnce(stripMarkup(s, ""));
    if (next === s) break;
    s = next;
  }
  return s
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------- 解析主流程 ---------------- */

/** 真实 feed 常见游离裸 &（?a=1&b=2），XML 层会判非法；预先规范为 &amp;。
 *  只规范不在合法实体形态后面的 &（不误伤 &amp; / &#123; / &#x1F;）。
 *  【第四轮 M-A】规范化同时累计输出的 UTF-8 字节数，越界立即中止并回报已累计字节：
 *  每个裸 & 放大 4 字节（'&' → '&amp;'），只按"进来的串"判上限等于留下 5 倍绕过口子。
 *  边扫边判而不是"先规范化再数字节"，是为了越界时不把放大后的 40MB 串整个构造出来。
 *  无裸 & 时走快速路径（复用已算好的原始字节数，不做第二次扫描）。 */
const BARE_AMP = /&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);)/g;

type NormalizeResult = { ok: true; text: string } | { ok: false; bytes: number };

function normalizeBareAmpersands(s: string, maxBytes: number, inputBytes: number): NormalizeResult {
  BARE_AMP.lastIndex = 0;
  const first = BARE_AMP.exec(s);
  if (!first) return { ok: true, text: s };
  if (inputBytes > maxBytes) return { ok: false, bytes: inputBytes };

  let out = "";
  let bytes = 0;
  let last = 0;
  let m: RegExpExecArray | null = first;
  while (m !== null) {
    const seg = s.slice(last, m.index);
    bytes += utf8ByteLength(seg);
    if (bytes > maxBytes) return { ok: false, bytes };
    out += seg + "&amp;";
    bytes += 5; // '&amp;' 恒为 5 个 ASCII 字节
    if (bytes > maxBytes) return { ok: false, bytes };
    last = m.index + 1;
    m = BARE_AMP.exec(s);
  }
  const tail = s.slice(last);
  bytes += utf8ByteLength(tail);
  if (bytes > maxBytes) return { ok: false, bytes };
  return { ok: true, text: out + tail };
}

/** 粗判是否"feed 形状"（根标签 rss / 前缀化 RDF / feed），用于错误分类 */
const FEED_ROOT_SNIFF = /<(?:[A-Za-z][\w.-]*:)?(?:rss|RDF|feed)(?=[\s/>])/;

type FeedRoot = { kind: "rss" | "rdf" | "atom"; node: OrderNode };

function detectRoot(doc: OrderNode[]): FeedRoot | undefined {
  for (const node of doc) {
    const tag = tagOf(node);
    if (!tag) continue;
    const local = localName(tag);
    if (local === "rss") return { kind: "rss", node };
    if (local === "RDF") return { kind: "rdf", node };
    if (local === "feed") return { kind: "atom", node };
  }
  return undefined;
}

/** Atom <link> 可能是对象/数组（带 rel/href 属性）：优先 rel=alternate 或无 rel 的 href，回退链接文本。
 *  判定按本地名（linkOf 只跳过非 link 节点），带前缀的 <atom:link href> 同样有效（缺陷 N1b）；
 *  优先级口径 = 文档顺序里第一个 rel 为空或 alternate 的 href 胜出，前缀不参与排序。
 *  【出口一律走 toIdentifierText（M-C）】：href 属性与文本形态都要做紧凑清洗（含控制符删除）。 */
function linkOf(nodes: OrderNode[]): string {
  let fallback = "";
  for (const node of nodes) {
    if (!isTag(node, "link")) continue;
    const href = attrOf(node, "href");
    if (href) {
      const cleaned = toIdentifierText(href);
      if (!cleaned) continue;
      const rel = attrOf(node, "rel") ?? "";
      if (rel === "" || rel === "alternate") return cleaned;
      if (!fallback) fallback = cleaned;
      continue;
    }
    const text = toIdentifierText(textOfNodes(childrenOf(node), ""));
    if (text) return text;
  }
  return fallback;
}

/** 时间源候选（优先级口径保持不变：pubDate → date(dc:date) → published → updated）。
 *  缺陷 N7：旧实现只取【第一个存在的时间元素】，它解析失败就整体放弃（返回 undefined），
 *  于是 `<pubDate>垃圾</pubDate><dc:date>2024-…Z</dc:date>` 拿不到本可解析的时间。
 *  现在【逐个试解析】，第一个能解析成有效 Date 的胜出；全都失败才置 undefined（不抛错）。
 *  ⚠️ 时间字段【不参与条目取舍】（第四轮 M-B）：它们不是身份，别把它加回身份判据。 */
const DATE_LOCALS = ["pubDate", "date", "published", "updated"];

function toDate(nodes: OrderNode[]): Date | undefined {
  for (const local of DATE_LOCALS) {
    for (const el of collectFields(nodes, local)) {
      const raw = textOfNodes(childrenOf(el), " ").trim();
      if (!raw) continue;
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return undefined;
}

/** id 兜底链：guid/id → link → rdf:about → dc:identifier → enclosure url → title。
 *  rdf:about / dc:identifier 一支（缺陷 N8）专治 RDF item 没有 <link> 的情况：
 *  否则 id 退化成 title，源站改标题就等于换主键，下游按 id 去重会重复入库。
 *  【M-B 口径】判据是"有非空值"，不是"字段被声明过"：空 `<guid></guid>`、无 url 的
 *  `<enclosure/>`、只有 pubDate 的条目都拿不到身份，链会一路退到 title（也空 → ""）。
 *  【M-C 口径】每个候选值都过 toIdentifierText，所以 id 永远满足标识符清洗规则。 */
function identityOf(nodes: OrderNode[], link: string, title: string, aboutAttr: string): string {
  const direct = toIdentifierText(identifierFieldText(nodes, ["guid", "id"]));
  if (direct) return direct;
  if (link) return link;
  if (aboutAttr) return aboutAttr;
  const identifier = toIdentifierText(identifierFieldText(nodes, ["identifier"]));
  if (identifier) return identifier;
  const enclosure = toIdentifierText(enclosureUrl(nodes));
  if (enclosure) return enclosure;
  return toIdentifierText(title);
}

/** 条目取舍（缺陷 N4 的第二版；第四轮 M-B 修正方向）。
 *  过滤判据 = 拿不到任何身份（id === ""）**且** title/link/content/summary 全空。
 *  上一版写成"身份字段被【声明】过就保留"，还把 DATE_LOCALS 混进身份表，结果是
 *  `<item><pubDate>…</pubDate></item>`、`<item><guid></guid></item>` 这类条目全部
 *  保留并批量产出 id="" ——恰好是注释里声称要防的"下游按空 id 去重互相覆盖"。
 *  现在 id 非空即保留（播客纯音频条目有 enclosure url 照样留），空壳一律过滤。 */
function toEntry(itemNode: OrderNode, nodes: OrderNode[]): FeedEntry | null {
  const title = toPlainText(fieldText(nodes, ["title"]));
  const link = linkOf(nodes);
  const mainRaw = fieldText(nodes, ["encoded", "content"]);
  const content = toPlainText(mainRaw || fieldText(nodes, ["description", "summary"]));
  const summary = toPlainText(fieldText(nodes, ["description", "summary"]) || mainRaw);
  const aboutAttr = toIdentifierText(attrByLocal(itemNode, "about"));
  const id = identityOf(nodes, link, title, aboutAttr);
  if (!id && !title && !link && !content && !summary) return null;
  const publishedAt = toDate(nodes);
  return { id, title, link, ...(publishedAt ? { publishedAt } : {}), summary, content };
}

/** 条目的信息完整度（同 id 冲突时决定"以谁为底"）。第五轮 M-E 把口径写成【两层字典序】并量化：
 *  ① 覆盖数 coverage —— 五个出口 title / link / content / summary / publishedAt 里非空的个数。
 *     为什么第一判据是"填了几个字段"而不是"内容有多少字"：下游入库/检索缺的是【字段】而不是
 *     字数。单纯比字数会让一条 5000 字的正文压掉"有链接 / 有时间"这类结构性信息，而字段缺失
 *     是不可逆的（正文偏短可以回源补，主键/链接丢了这条条目就没法定位了）。
 *     时间按【1 个单位】计（不给小数权重）：publishedAt 是可排序、可增量判定的硬字段，
 *     缺失代价与缺 title 同级，故与文本出口同权 —— 这条权重由 M-E 用例的 title 冲突钉死
 *     （去掉时间权重 → 覆盖数打平 → 平手取先出现者 → 断言立刻变红）。
 *  ② 体量 volume —— content + summary 的字符数，只在覆盖数打平时分胜负（正文更饱满的那条当底）。
 *     用字符数而不是字节/token 数：这里只做相对比较、不跨语言计量，字符数无歧义且免编码开销。
 *  两层都相等 ⇒ tie-break = 文档顺序里【先出现】的那条（确定性、可复现，由断言钉住，
 *  不允许只写在注释里）。 */
function completeness(entry: FeedEntry): [number, number] {
  const coverage =
    (entry.title ? 1 : 0) +
    (entry.link ? 1 : 0) +
    (entry.content ? 1 : 0) +
    (entry.summary ? 1 : 0) +
    (entry.publishedAt ? 1 : 0);
  return [coverage, entry.content.length + entry.summary.length];
}

/** 完整度字典序比较：a 严格优于 b 才返回 true（相等 ⇒ false ⇒ 保留先出现的） */
function isMoreComplete(a: [number, number], b: [number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] > b[1];
}

/** 【字段并集】合并（第五轮 M-E）：以胜出者 base 为底，把落选者 other 的非空出口补进底里的空位。
 *  字段选择规则（唯一口径，不随调用点变化）：
 *   - 只有一边非空 ⇒ 取那一非空边（互补信息一律保住，不再静默丢字段）。
 *   - 两边都非空（冲突）⇒ 取【底】的值；底的选定规则见 completeness。
 *   - id 不参与合并：它正是本次合并的键，两边必然相同。
 *  为什么冲突时"取底"而不是逐字段各挑一种（比如标题取短的、正文取长的）：逐字段混挑会造出
 *  源站从未提交过的混合条目（标题来自 A、正文来自 B 的另一个版本），条目内字段之间是有版本
 *  一致性的；只有"补空位"这种保守并集不会伪造组合。
 *  publishedAt 两边都缺失时整个键不设（保持 `"publishedAt" in entry === false` 的既有口径）。 */
function mergeEntryFields(base: FeedEntry, other: FeedEntry): FeedEntry {
  const publishedAt = base.publishedAt ?? other.publishedAt;
  return {
    id: base.id,
    title: base.title || other.title,
    link: base.link || other.link,
    ...(publishedAt ? { publishedAt } : {}),
    summary: base.summary || other.summary,
    content: base.content || other.content,
  };
}

/** 同一 id 只保留一条：按【字段并集】合并（第五轮 M-E；旧实现是覆盖式替换），
 *  底 = 信息更完整的那条（见 completeness），位置仍取该 id 首次出现的下标；完整度相同
 *  保留先出现的。空 id 不参与（M-B 之后仍可能有"只有正文没有身份"的条目，它们本来就
 *  没有可用主键，合并反而丢内容）。
 *  为什么按 id 而不是按节点对象：preserveOrder 下根下与 channel 下的两个 `<item>` 是
 *  【两个不同对象】，同一 rdf:about 各写一份时对象身份去重永不可能碰撞（上一版那段是
 *  空转代码，摘掉 86 条断言无感），而下游按 id 入库时它们会互相覆盖。
 *  RSS / RDF / Atom 三个分支都走这里（Atom 分支曾漏调用，已由 M-E 用例钉住）。 */
function dedupeById(entries: FeedEntry[]): FeedEntry[] {
  const slotOfId = new Map<string, number>();
  const out: FeedEntry[] = [];
  for (const entry of entries) {
    if (!entry.id) {
      out.push(entry);
      continue;
    }
    const slot = slotOfId.get(entry.id);
    if (slot === undefined) {
      slotOfId.set(entry.id, out.length);
      out.push(entry);
      continue;
    }
    const held = out[slot];
    out[slot] = isMoreComplete(completeness(entry), completeness(held))
      ? mergeEntryFields(entry, held)
      : mergeEntryFields(held, entry);
  }
  return out;
}

/** 根下的 channel 节点（文档顺序；前缀化 rss:channel 同样算，元数据前缀除外） */
function collectChannelNodes(rootChildren: OrderNode[]): OrderNode[] {
  return rootChildren.filter((node) => isTag(node, "channel"));
}

/** 收集 RSS 2.0 / RDF 的条目节点（文档顺序）：遍历【全部】 channel 的 item，
 *  外加根下的 item（RDF 的两种历史写法都真实存在：item 挂根下 / 挂 channel 下）。
 *  第四轮应修项 3：旧实现只取 findField 找到的【第一个】 channel，
 *  `<rss>` 下两个 channel 各带 1 个 item 时实测 n=1，第二个 channel 整批静默丢失。 */
function collectItemNodes(rootChildren: OrderNode[]): OrderNode[] {
  const items: OrderNode[] = [];
  for (const node of rootChildren) {
    if (isTag(node, "item")) {
      items.push(node);
    } else if (isTag(node, "channel")) {
      for (const inner of childrenOf(node)) {
        if (isTag(inner, "item")) items.push(inner);
      }
    }
  }
  return items;
}

export function parseFeed(xml: string): ParsedFeed {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new NotAFeedError("输入为空，无法识别为 feed");
  }
  if (xml.length > MAX_FEED_INPUT_CHARS) {
    throw new FeedInputTooLargeError(
      `输入 ${xml.length} 字符，超过字符数前置上限 ${MAX_FEED_INPUT_CHARS} 字节量级（8MiB）——疑似畸形/被截断的大输入`,
    );
  }
  const inputBytes = utf8ByteLength(xml);
  if (inputBytes > MAX_FEED_INPUT_BYTES) {
    // 超大【原始】输入在这里就挡掉，绝不为了规范化而先把放大后的串构造出来
    throw new FeedInputTooLargeError(
      `输入 ${inputBytes} 字节（UTF-8），超过上限 ${MAX_FEED_INPUT_BYTES} 字节（8MiB）——疑似畸形/被截断的大输入（CJK 等多字节文本按字符数看不出来，故按字节拦）`,
    );
  }

  const feedLike = FEED_ROOT_SNIFF.test(xml);
  // 预算按【实际要解析的串】计：裸 & 规范化是 1→5 倍放大，越界在这里复检并中止
  const normalized = normalizeBareAmpersands(xml, MAX_FEED_INPUT_BYTES, inputBytes);
  if (!normalized.ok) {
    throw new FeedInputTooLargeError(
      `裸 & 规范化（'&'→'&amp;'，最多 5 倍放大）后已达 ${normalized.bytes} 字节（UTF-8），超过上限 ${MAX_FEED_INPUT_BYTES} 字节（8MiB）——原始输入本身未超限，但实际要解析的串超限（畸形/被截断的大输入）`,
    );
  }

  let doc: OrderNode[];
  try {
    doc = parser.parse(normalized.text, true) as unknown as OrderNode[];
  } catch (e) {
    if (feedLike) {
      throw new MalformedXMLError(
        `feed 语法有瑕疵，无法解析（如标签未闭合/非法字符）: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    throw new NotAFeedError("输入不是合法 XML，也找不到 rss / rdf:RDF / feed 根标签，可能不是 RSS/Atom 数据源");
  }

  const root = detectRoot(doc);
  if (!root) {
    const rootKeys = doc
      .map(tagOf)
      .filter((t): t is string => Boolean(t))
      .join(", ");
    throw new NotAFeedError(
      `根标签不是 rss / rdf:RDF / feed，输入可能不是 RSS/Atom 数据源（顶层节点: ${rootKeys || "(空)"}）`,
    );
  }

  const rootChildren = childrenOf(root.node);
  if (root.kind === "atom") {
    // Atom：feed.title / feed.entry（entry 按本地名判定，支持 atom:entry 等前缀形态）
    const title = toPlainText(fieldText(rootChildren, ["title"]));
    const entries: FeedEntry[] = [];
    for (const node of rootChildren) {
      if (!isTag(node, "entry")) continue;
      const entry = toEntry(node, childrenOf(node));
      if (entry) entries.push(entry);
    }
    return { title, entries: dedupeById(entries) };
  }

  // RSS 2.0 / RSS 1.0 RDF：channel 可能有多个（旧实现只认第一个 → 整批条目丢失），
  // 条目既然遍历了【全部】 channel，频道标题也必须按同一口径取，否则出现"n=2 却 title 空"
  // 的自相矛盾（第五轮 M-H）。口径：文档顺序里【第一个非空】的 channel title。
  //  - 为什么"第一个非空"而不是"拼接全部"：feed.title 是单一频道名，多 channel 的现实语义是
  //    同一站点的分批频道（镜像/分类），拼接会造出源站并不存在的复合标题。
  //  - 为什么跳过空 title 而不是"第一个 channel 的 title（哪怕是空）"：真实脏 feed 里第一个
  //    channel 常只带条目列表（RDF 的 channel 只声明 rdf:Seq），名字写在后面的 channel 上，
  //    取空串等于把可用信息白扔。全部为空时保持空串（绝不退回去抓 item 的 title）。
  let title = "";
  for (const channel of collectChannelNodes(rootChildren)) {
    const candidate = toPlainText(fieldText(childrenOf(channel), ["title"]));
    if (candidate) {
      title = candidate;
      break;
    }
  }
  const entries: FeedEntry[] = [];
  for (const node of collectItemNodes(rootChildren)) {
    const entry = toEntry(node, childrenOf(node));
    if (entry) entries.push(entry);
  }
  return { title, entries: dedupeById(entries) };
}
