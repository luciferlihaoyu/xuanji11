/**
 * Feed 解析模块（RSS 2.0 / RSS 1.0 RDF / Atom 三种根形态统一解析）
 * 独立于具体连接器，供 RSS 数据源接入复用。
 * 设计要点：
 * - 用 fast-xml-parser 解析，removeNSPrefix 统一吃掉 rdf:/dc:/content:/atom: 等命名空间前缀；
 * - CDATA 默认会与普通文本合并进标签值，无需特殊处理；
 * - 标题/正文一律剥掉 HTML 标签并解码实体，输出纯文本；
 * - 非 feed 输入（HTML 页面、普通文本等）抛出带明确信息的 Error，绝不静默返回 0 条。
 */

import { XMLParser } from "fast-xml-parser";

export interface FeedEntry {
  /** 优先 guid / id，回退 link，再回退 title */
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

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

/** 非 feed 输入的可判别错误 */
function notAFeed(reason: string): Error {
  return new Error(`无法识别的 feed 格式：${reason}，输入可能不是 RSS/Atom 数据源`);
}

/** 把 FXP 返回的任意值压平成字符串文本（CDATA/多文本块合并后的 #text 取首段） */
function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#text" in o) return textOf(o["#text"]);
    for (const val of Object.values(o)) {
      if (typeof val === "string") return val;
    }
  }
  return "";
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(v)) return asObj(v[0]);
  return typeof v === "object" && v != null ? (v as Record<string, unknown>) : undefined;
}

/** 标准外的 HTML 命名实体（amp/lt/gt/quot/apos 已由解析器解码，这里不重复解码以免二次解码） */
const HTML_NAMED: Record<string, string> = {
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
    const code = /^[xX]/.test(g1) ? parseInt(g1.slice(1), 16) : parseInt(g1.slice(1), 10);
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

/** 去 HTML 标签 + 解码实体，并折叠空白，输出纯文本 */
function toPlainText(raw: string): string {
  return raw
    .replace(/&([a-zA-Z][a-zA-Z0-9]*|#[xX]?[0-9a-fA-F]+);/g, (m, g1) => decodeOneEntity(g1, m))
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstText(o: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const t = textOf(o[key]).trim();
    if (t) return t;
  }
  return "";
}

/** Atom <link> 可能是对象/数组（带 rel/href 属性），优先取 rel=alternate 或无 rel 的 href */
function pickLink(raw: unknown): string {
  let fallback = "";
  for (const l of toArray(raw as unknown)) {
    if (typeof l === "string" && l) {
      if (!fallback) fallback = l;
      continue;
    }
    const o = asObj(l);
    if (!o || typeof o.href !== "string" || !o.href) continue;
    const rel = typeof o.rel === "string" ? o.rel : "";
    if (rel === "" || rel === "alternate") return o.href;
    if (!fallback) fallback = o.href;
  }
  return fallback;
}

/** 解析时间字段：失败返回 undefined，不抛错 */
function toDate(v: unknown): Date | undefined {
  const s = textOf(v).trim();
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseFeed(xml: string): ParsedFeed {
  if (typeof xml !== "string" || !xml.trim()) {
    throw notAFeed("输入为空");
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml, true) as Record<string, unknown>;
  } catch {
    throw notAFeed("输入不是合法的 XML（解析失败）");
  }

  // 三种根形态：rss（RSS 2.0）/ RDF（RSS 1.0，removeNSPrefix 后）/ feed（Atom）
  const rssRoot = asObj(doc["rss"]);
  const rdfRoot = asObj(doc["RDF"] ?? doc["rdf:RDF"]);
  const atomRoot = asObj(doc["feed"] ?? doc["atom:feed"]);
  if (!rssRoot && !rdfRoot && !atomRoot) {
    const rootKeys = Object.keys(doc).join(", ") || "(空)";
    throw notAFeed(`根标签不是 rss / rdf:RDF / feed（顶层节点: ${rootKeys}）`);
  }

  const titleRaw = firstText(rssRoot?.channel ?? rdfRoot ?? {}, ["title"]) || firstText(atomRoot ?? {}, ["title"]);
  const title = toPlainText(titleRaw);

  // 条目位置：RSS 2.0 在 rss.channel.item；RDF 的 item 直接挂在根下；Atom 在 feed.entry
  const channel = asObj(rssRoot?.channel);
  const rawItems = rssRoot
    ? toArray(channel?.item)
    : rdfRoot
      ? toArray(rdfRoot["item"])
      : toArray((atomRoot as Record<string, unknown>)["entry"]);

  const entries: FeedEntry[] = rawItems.map((raw) => {
    const item = asObj(raw) ?? {};
    const link = pickLink(item["link"]) || textOf(item["link"]).trim();
    const content = toPlainText(firstText(item, ["content"]) || firstText(item, ["description", "summary"]));
    const summary = toPlainText(firstText(item, ["description", "summary"]) || firstText(item, ["content"]));
    const publishedAt = toDate(item["pubDate"] ?? item["date"] ?? item["published"] ?? item["updated"]);
    const id = textOf(item["guid"] ?? item["id"]).trim() || link || textOf(item["title"]).trim();
    return { id, title: toPlainText(textOf(item["title"])), link, ...(publishedAt ? { publishedAt } : {}), summary, content };
  });

  return { title, entries };
}
