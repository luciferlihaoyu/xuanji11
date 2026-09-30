/**
 * feed-parse 单元测试
 * 固件为真实抓取的 RSS 2.0 / RDF (RSS 1.0) / Atom 三种格式样本，只读不改。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  parseFeed,
  MalformedXMLError,
  NotAFeedError,
  FeedInputTooLargeError,
  MAX_FEED_INPUT_BYTES,
  MAX_FEED_INPUT_CHARS,
  MAX_MARKUP_SPAN,
  MAX_MARKUP_NAME_LEN,
  MAX_MARKUP_ABSOLUTE_SPAN,
  findMarkupStart,
  isWellFormedMarkupAt,
  createMarkupScanContext,
  utf8ByteLength,
  HTML_NAMED,
} from "./feed-parse";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

const hnRss2 = readFixture("hn-rss2.xml");
const natureRdf = readFixture("nature-rdf.xml");
const redditAtom = readFixture("reddit-atom.xml");


/**
 * 「标签形态」不变式 —— 【第四轮统一】：判定来自被测模块导出的唯一谓词
 * isWellFormedMarkupAt / findMarkupStart，测试不再自带第二套正则。
 *
 * 为什么要这么改：第三轮的 TAG_SHAPE = /<\/?[a-zA-Z!?]/ 与实现里的"什么算标签"是两套口径，
 * 于是出现两种互相矛盾的要求——
 *  ① 实现把 `a<b and c>d` 当标签吃掉（句子被剥坏，缺陷 N5）；
 *  ② 给实现加"256 字符跨度上限"后，长伪标签 `<b…` 被留在输出里，又被这套正则判成残留。
 * 共用同一把尺子之后，「被当成标签吃掉的」与「断言不许残留的」永远是同一个集合：
 * 尺子判不是标记而留下的字面文本（`a<b and c>d`、超长的 `<bxxx…>`）绝不会再被断言判红，
 * 反过来实现也不可能"吃了一套、断言另一套"。
 */
function expectNoMarkup(text: string, where = "文本"): void {
  const at = findMarkupStart(text);
  expect(at, `${where} 不应残留 well-formed 标签形态，实际起点 ${at}: ${JSON.stringify(text.slice(0, 80))}`).toBe(-1);
}

/* ==================================================================================
 * 第七轮 item1：FeedInputTooLargeError 的三条文案改成【模板锚定】
 * ----------------------------------------------------------------------------------
 * 为什么必须换：此前这几处只有关键字钉（/字节/、/上限/、/规范化/、数字串），复核实测
 * 把实现里的「已达」改成「达到」、把「超过上限」改成「超出上限」、甚至整句语序重排，
 * 237 条用例【全绿】—— 同义替换与重排能静默漂过。这条错误文案是运维排障时判断
 * "该缩源还是该调上限"的唯一线索，漂了等于没有。本项目第五轮已经栽过一次同类问题
 * （NotAFeedError 文案零断言 ⇒ 漂移无法归因，已在 r6-item6 组补齐），这条是残留的同类洞。
 * 现在的做法：固定部分逐字写进 ^…$ 锚定模板（片段从实现原文逐字抄出），
 * 动态部分（实际字符数/字节数/上限值）用捕获组取出后单独核对数值 ⇒ 【改一个字必红】。
 * 能咬住的改动类别：
 *   ① 同义替换（已达→达到、超过→超出、疑似→疑是）② 语序重排（"超过上限 X 字节"↔"X 字节超过上限"）
 *   ③ 增删字/删尾注（去掉"——疑似畸形/被截断的大输入"、去掉"（UTF-8）"）
 *   ④ 标点与全半角漂移（，→, 、（→( 、——→-）⑤ 数字位丢失或与预算不符
 * ================================================================================== */

/** 把固定文案片段逐字拼成 ^…$ 锚定正则；动态数字位用 null 占位（编译成捕获组 (\\d+)）。
 *  每个片段都先做正则转义，文案里的 () . / 等符号不会退化成正则元字符。 */
function anchoredTemplate(segs: Array<string | null>): RegExp {
  const body = segs
    .map((s) => (s === null ? "(\\d+)" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

/** 文案①「字符数前置快速拒绝」锚定模板（上限数字绑定导出常量，常量本身另有专门用例钉值）。 */
const PIN_TOO_LARGE_CHARS = anchoredTemplate([
  "输入 ",
  null,
  " 字符，超过字符数前置上限 ",
  String(MAX_FEED_INPUT_CHARS),
  " 字节量级（8MiB）——疑似畸形/被截断的大输入",
]);
/** 文案②「原始字节超限（前置拒绝）」锚定模板。 */
const PIN_TOO_LARGE_BYTES = anchoredTemplate([
  "输入 ",
  null,
  " 字节（UTF-8），超过上限 ",
  String(MAX_FEED_INPUT_BYTES),
  " 字节（8MiB）——疑似畸形/被截断的大输入（CJK 等多字节文本按字符数看不出来，故按字节拦）",
]);
/** 文案③「裸 & 规范化放大越界」锚定模板。 */
const PIN_TOO_LARGE_NORMALIZED = anchoredTemplate([
  "裸 & 规范化（'&'→'&amp;'，最多 5 倍放大）后已达 ",
  null,
  " 字节（UTF-8），超过上限 ",
  String(MAX_FEED_INPUT_BYTES),
  " 字节（8MiB）——原始输入本身未超限，但实际要解析的串超限（畸形/被截断的大输入）",
]);

/** 断言文案【逐字】命中锚定模板，并把捕获到的动态数字按顺序交回调用方核对。
 *  不命中即抛（用例红），红字里带上实际文案原文，便于归因是哪一段漂了。 */
function expectMessageTemplate(message: string, pin: RegExp, where: string): number[] {
  const m = pin.exec(message);
  if (!m) {
    throw new Error(
      `${where}：文案已漂移，不再逐字命中锚定模板\n  实际: ${JSON.stringify(message)}\n  模板: ${pin.source}`,
    );
  }
  return m.slice(1).map((v) => Number(v));
}

describe("parseFeed 三种根形态（结构性断言）", () => {
  it("RSS 2.0（hn-rss2.xml）解析出 20 条", () => {
    const feed = parseFeed(hnRss2);
    expect(feed.entries).toHaveLength(20);
    expect(feed.title).toContain("Hacker News");
  });

  it("RDF / RSS 1.0（nature-rdf.xml）解析出 75 条", () => {
    const feed = parseFeed(natureRdf);
    expect(feed.entries).toHaveLength(75);
    expect(feed.title).toBe("Nature");
  });

  it("Atom（reddit-atom.xml）解析出 25 条", () => {
    const feed = parseFeed(redditAtom);
    expect(feed.entries).toHaveLength(25);
  });
});

describe("parseFeed 内容清洗", () => {
  it("Nature 条目 content 非空且不含 HTML 标签（去标签生效）", () => {
    const feed = parseFeed(natureRdf);
    for (const entry of feed.entries) {
      expect(entry.content.trim().length).toBeGreaterThan(0);
      expectNoMarkup(entry.content, "Nature 条目 content");
    }
    // CDATA 内嵌的 <i> 等标签必须被剥掉，正文文字保留
    expect(feed.entries[0].content).toContain("Published online");
  });

  it("HN 的 CDATA description 能正确取出为纯文本", () => {
    const feed = parseFeed(hnRss2);
    const first = feed.entries[0];
    // HN description 是 CDATA 包裹的 HTML（<p>Article URL: <a href=...>）
    expect(first.content).toContain("Article URL:");
    expect(first.content).toContain("blog.mozilla.org");
    expectNoMarkup(first.content, "HN 首条 content");
  });

  it("script/style/注释块连同内容整体丢弃（正文不泄漏 JS/CSS/注释）", () => {
    const xml =
      "<rss version=\"2.0\"><channel><title>T</title><item><title>I</title>" +
      "<description><![CDATA[<p>正文A</p><!-- 隐藏注释 --><script>var secret=1;</script>" +
      "<style>.a{color:red}</style><p>正文B</p>]]></description>" +
      "</item></channel></rss>";
    const feed = parseFeed(xml);
    const content = feed.entries[0].content;
    expect(content).toBe("正文A 正文B");
    expect(content).not.toContain("secret");
    expect(content).not.toContain("color:red");
    expect(content).not.toContain("隐藏注释");
  });

  it("Reddit 固件双层转义：正文/摘要无残留命名实体（&amp; &quot; 等）", () => {
    const feed = parseFeed(redditAtom);
    const residual = /&[a-zA-Z][a-zA-Z0-9]*;/;
    for (const entry of feed.entries) {
      expect(entry.content).not.toMatch(residual);
      expect(entry.summary).not.toMatch(residual);
      // 数字型实体（含 &#x200B; 之类）同样不得残留
      expect(entry.content).not.toMatch(/&#[0-9xXa-fA-F]+[^0-9;]*;/);
    }
    // &/&quot; 这类必须真的被解掉（URL 里常见的 &format=auto 之类参数应完整）
    const withAmp = feed.entries.find((e) => e.content.includes("&"));
    expect(withAmp).toBeTruthy();
  });

  it("实体解码：&amp; &lt; &#39; 等被正确解码", () => {
    const xml =
      '<rss version="2.0"><channel><title>T &amp; T</title><item>' +
      "<title>A &amp; B</title>" +
      "<description>x &lt;tag&gt; y &#39;quoted&#39; &amp; z&nbsp;end</description>" +
      "</item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.title).toBe("T & T");
    expect(feed.entries[0].title).toBe("A & B");
    const content = feed.entries[0].content;
    // &lt;tag&gt; 解码后按标记剥离（输出纯文本），不得残留实体或标签
    expect(content).not.toContain("tag>");
    expectNoMarkup(content, "content");
    expect(content).toContain("'quoted'");
    expect(content).toContain("&");
    // 【口径修正，第三轮】"不得残留任何 XML/HTML 实体形态" 说法过宽：本模块只解
    // HTML_NAMED + 数字型这两类【已知】实体，未知实体（&fjorde;）按保守策略原样保留。
    // 因此这里断言"已知实体不得残留"，未知实体单独在下面的用例里断言其保留行为。
    expect(content).not.toMatch(/&(amp|lt|gt|quot|apos|nbsp|copy|reg|trade|hellip|mdash|ndash|times|divide|#\d+|#x[0-9a-fA-F]+);/i);
  });

  it("未知实体（&fjorde;）保守保留原文，不当已知实体乱解", () => {
    const content = parseFeed(
      '<rss version="2.0"><channel><title>T</title><item><title>I</title>' +
        "<description>fjord &fjorde; &amp; done</description></item></channel></rss>",
    ).entries[0].content;
    expect(content).toBe("fjord &fjorde; & done");
  });
});

describe("parseFeed 时间与链接", () => {
  it("Reddit Atom 条目能取到非空 publishedAt（Atom 时间解析生效）", () => {
    const feed = parseFeed(redditAtom);
    for (const entry of feed.entries) {
      expect(entry.publishedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(entry.publishedAt!.getTime())).toBe(false);
    }
  });

  it("HN 条目能取到 pubDate 且 link 为原文链接", () => {
    const feed = parseFeed(hnRss2);
    expect(feed.entries[0].publishedAt).toBeInstanceOf(Date);
    expect(feed.entries[0].link).toMatch(/^https:\/\//);
  });
});

describe("parseFeed 非 feed 输入可判别报错", () => {
  it("传入 HTML 页面时抛出明确 Error（0 条目是合法返回，报错只针对非 feed 根）", () => {
    const html = "<!DOCTYPE html><html><head><title>example</title></head><body><p>hello</p></body></html>";
    expect(() => parseFeed(html)).toThrowError(NotAFeedError);
  });

  it("传入普通文本 / JSON 同样抛出 NotAFeedError", () => {
    expect(() => parseFeed('{"hello": "world"}')).toThrowError(NotAFeedError);
    expect(() => parseFeed("just a random string")).toThrowError(NotAFeedError);
  });
});

describe("P0-1 属性与本地名：属性值绝不当正文", () => {
  it("Atom type=xhtml 标题递归进 div 取真实文字", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom">' +
      '<title type="xhtml"><div>Real Title <b>bold</b></div></title>' +
      "<entry><id>e1</id>" +
      '<title type="xhtml"><div class="x">Entry <i>Italic</i> End</div></title>' +
      '<content type="xhtml"><div>Body &amp;amp; more</div></content>' +
      "</entry></feed>";
    const feed = parseFeed(xml);
    expect(feed.title).toBe("Real Title bold");
    expect(feed.entries[0].title).toBe("Entry Italic End");
    expect(feed.entries[0].content).toBe("Body & more");
  });

  it("media:content 这类元数据绝不充当正文，真描述进 content", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      '<media:content url="https://cdn/video.mp4"/>' +
      "<description>真正的描述文字</description>" +
      "</item></channel></rss>";
    const feed = parseFeed(xml);
    const entry = feed.entries[0];
    expect(entry.content).toBe("真正的描述文字");
    expect(entry.content).not.toContain(".mp4");
    expect(entry.summary).toBe("真正的描述文字");
  });
});

describe("P0-2/P0-3 标签形态不变式与迭代清洗", () => {
  // 取舍说明（有意为之）：本模块输出供知识库检索用，宁可丢掉"作者本意是字面文本的
  // <div>"这类尖括号文本，也绝不让输出残留标签形态——见模块文档注释。
  it("单层转义的 <div> 文本被丢弃（有意取舍），KEEP 等真实文字保留且无标签形态", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item><title>I</title>' +
      "<description>Set the &lt;div&gt; style to none KEEP</description>" +
      "</item></channel></rss>";
    const content = parseFeed(xml).entries[0].content;
    expect(content).toBe("Set the style to none KEEP");
    expectNoMarkup(content, "content");
  });

  it("双层转义 &amp;lt;b&amp;gt; 迭代清洗后无标签形态，bold 保留", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item><title>I</title>' +
      "<description>use &amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt; ok</description>" +
      "</item></channel></rss>";
    const content = parseFeed(xml).entries[0].content;
    expectNoMarkup(content, "content");
    expect(content).toContain("bold");
    expect(content).toContain("ok");
  });

  it("三层转义同样无标签形态", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item><title>I</title>' +
      "<description>x &amp;amp;amp;lt;q&amp;amp;amp;gt;mark&amp;amp;amp;lt;/q&amp;amp;amp;gt; end</description>" +
      "</item></channel></rss>";
    const content = parseFeed(xml).entries[0].content;
    expectNoMarkup(content, "content");
    expect(content).toContain("mark");
  });

  it("CDATA 字面 <b> 标签被剥掉，无标签形态", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item><title>I</title>' +
      "<description><![CDATA[try <b>bold</b> end]]></description>" +
      "</item></channel></rss>";
    const content = parseFeed(xml).entries[0].content;
    expect(content).toBe("try bold end");
  });
});

describe("P0-4 脏 feed 容错与错误分类", () => {
  it("裸 &（未转义）的链接不再导致整源失败，feed 正常解析", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item><title>t</title>' +
      "<link>https://x.com/a?b=1&c=2&d=3</link>" +
      "<description>d &amp; e</description>" +
      "</item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].link).toBe("https://x.com/a?b=1&c=2&d=3");
  });

  it("feed 形状但 XML 有瑕疵 → MalformedXMLError（与非 feed 区分）", () => {
    const truncated = "<rss><channel><title>T</title><item><title>x</title>";
    expect(() => parseFeed(truncated)).toThrowError(MalformedXMLError);
  });

  it("非 feed 输入 → NotAFeedError（可判别）", () => {
    expect(() => parseFeed("<div><p>hello")).toThrowError(NotAFeedError);
  });
});

describe("P0-5 混合内容不得丢字", () => {
  it("title 内嵌 <b> 的文本按文档顺序全部取出", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      "<title>A <b>B</b> C</title><description>d</description>" +
      "</item></channel></rss>";
    expect(parseFeed(xml).entries[0].title).toBe("A B C");
  });
});

describe("P1 边界行为", () => {
  it("无任何身份值且 title/link/content/summary 全空的 <item/> 被过滤（本用例只断言过滤，空 id 的另一半口径见 M-B 专组）", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title>' +
      "<item></item>" +
      "<item><title>Real</title><description>d</description></item>" +
      "</channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("Real");
  });

  it("超过 8MB 的输入抛出可读的 FeedInputTooLargeError", () => {
    const big = "<rss>" + "a".repeat(8 * 1024 * 1024);
    expect(() => parseFeed(big)).toThrowError(FeedInputTooLargeError);
  });
});

/* ================== 第三轮回归：前缀形态 / RDF 结构（N1a N1b N2） ================== */

describe("N1a 带前缀的结构标签按本地名判定（回归：条目全丢）", () => {
  it("atom:feed / atom:entry / atom:title 前缀化 Atom 不再丢条目", () => {
    const xml =
      '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">' +
      "<atom:title>P</atom:title>" +
      '<atom:entry><atom:title>E1</atom:title><atom:link href="https://x/1"/></atom:entry>' +
      "</atom:feed>";
    const feed = parseFeed(xml);
    expect(feed.title).toBe("P");
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].title).toBe("E1");
    expect(feed.entries[0].link).toBe("https://x/1");
  });

  it("默认命名空间 + 前缀混合：ns:entry 与 entry 同批取出且顺序为文档顺序", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:a="http://www.w3.org/2005/Atom">' +
      "<title>T</title>" +
      "<entry><title>E1</title><link href=\"https://x/1\"/></entry>" +
      "<a:entry><title>E2</title><link href=\"https://x/2\"/></a:entry>" +
      "</feed>";
    const feed = parseFeed(xml);
    expect(feed.entries.map((e) => e.title)).toEqual(["E1", "E2"]);
    expect(feed.entries.map((e) => e.link)).toEqual(["https://x/1", "https://x/2"]);
  });

  it("前缀化 RDF item 与 item 内前缀化字段（rss:item / rss:title）不丢", () => {
    const xml =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#" xmlns:rss="http://purl.org/rss/1.0/">' +
      '<rss:item rdf:about="https://x/1"><rss:title>A</rss:title></rss:item>' +
      '<rss:item rdf:about="https://x/2"><rss:title>B</rss:title></rss:item>' +
      "</rdf:RDF>";
    const feed = parseFeed(xml);
    expect(feed.entries.map((e) => e.title)).toEqual(["A", "B"]);
  });

  it("元数据前缀（media:*）绝不冒充结构标签/字段：media:description 不覆盖 description", () => {
    const xml =
      '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title><item>' +
      "<title>I</title>" +
      "<media:description>MEDIA-SPAM</media:description>" +
      "<description>real description</description>" +
      "</item></channel></rss>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.content).toBe("real description");
    expect(entry.content).not.toContain("MEDIA-SPAM");
  });
});

describe("N1b 前缀化 link 取链接（回归：atom:link href 取不到）", () => {
  it("RSS item 内的 <atom:link href> 能取到 link", () => {
    const xml =
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>T</title>' +
      "<item><title>I</title><atom:link href=\"https://x/2\"/></item>" +
      "</channel></rss>";
    expect(parseFeed(xml).entries[0].link).toBe("https://x/2");
  });

  it("HN 固件的 channel 级 atom:link 不污染条目；item 级 <link> 仍是条目链接", () => {
    const feed = parseFeed(hnRss2);
    expect(feed.entries).toHaveLength(20);
    for (const entry of feed.entries) {
      expect(entry.link).toMatch(/^https?:\/\//);
      expect(entry.link).not.toBe("https://hnrss.org/frontpage");
    }
  });

  it("前缀化 link 的【文本形态】（无 href）也能取到链接", () => {
    const xml =
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>T</title>' +
      "<item><title>I</title><atom:link>https://x/text-form</atom:link></item>" +
      "</channel></rss>";
    expect(parseFeed(xml).entries[0].link).toBe("https://x/text-form");
  });

  it("rel=alternate/无 rel 按文档顺序取第一个；其它 rel 只做兜底", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:a="http://www.w3.org/2005/Atom"><title>T</title>' +
      "<entry><id>e</id>" +
      '<link rel="replies" href="https://x/replies"/>' +
      '<a:link href="https://x/prefixed"/>' +
      '<link rel="alternate" href="https://x/alternate"/>' +
      "</entry></feed>";
    // 口径（沿用模块既有语义并写清）：文档顺序里第一个 rel 为空或 alternate 的 href 胜出，
    // 前缀不参与优先级；只有非 alternate/self 之外关系的 link 时，退回它当兜底。
    expect(parseFeed(xml).entries[0].link).toBe("https://x/prefixed");

    const onlyOtherRel =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>' +
      '<entry><id>e</id><link rel="replies" href="https://x/replies"/></entry></feed>';
    expect(parseFeed(onlyOtherRel).entries[0].link).toBe("https://x/replies");
  });
});

describe("N2 RDF 的 item 挂在 channel 下（回归：整批丢失）", () => {
  it("item 全在 <channel> 下的 RDF 能取出全部条目", () => {
    const xml =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#"><channel rdf:about="https://c/">' +
      "<title>C</title>" +
      "<item><title>A</title><link>https://x/a</link></item>" +
      "<item><title>B</title><link>https://x/b</link></item>" +
      "</channel></rdf:RDF>";
    const feed = parseFeed(xml);
    expect(feed.entries.map((e) => e.title)).toEqual(["A", "B"]);
    expect(feed.entries.map((e) => e.link)).toEqual(["https://x/a", "https://x/b"]);
  });

  it("根下 item 与 channel 下 item 混合时按文档顺序并集（本用例断言的是顺序并集；同 id 合并见下面两条）", () => {
    const xml =
      "<rdf:RDF>" +
      '<channel rdf:about="https://c/"><title>C</title>' +
      "<item><title>in-channel</title></item></channel>" +
      "<item><title>under-root</title></item>" +
      "</rdf:RDF>";
    expect(parseFeed(xml).entries.map((e) => e.title)).toEqual(["in-channel", "under-root"]);
  });

  it("RDF 同一 rdf:about 在根下与 channel 下各一份 → 只留信息更完整的一条（旧版给 n=2 两条同 id）", () => {
    const xml =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#"><channel rdf:about="https://c/">' +
      '<item rdf:about="https://x/dup"><title>lean</title></item></channel>' +
      '<item rdf:about="https://x/dup"><title>Full Title</title><link>https://x/dup</link>' +
      "<description>body</description></item></rdf:RDF>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    // 完整度更高的一条胜出（channel 内的精简声明会被它替换），位置仍取首次出现的下标
    expect(feed.entries[0].title).toBe("Full Title");
    expect(feed.entries[0].content).toBe("body");
    expect(feed.entries[0].id).toBe("https://x/dup");
  });

  it("RSS 2.0 同 guid 两条也合并为一条（同一主键在下游本就会互相覆盖）", () => {
    const xml =
      "<rss><channel><title>C</title>" +
      "<item><guid>DUP</guid><title>lean</title></item>" +
      "<item><guid>DUP</guid><title>Full</title><link>https://x</link></item>" +
      "</channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].title).toBe("Full");
  });

  it("去重只针对非空 id：两条只有正文、都拿不到身份的条目各自保留（合并没有主键的东西只会丢内容）", () => {
    const xml =
      "<rss><channel><title>C</title>" +
      "<item><description>b1</description></item><item><description>b2</description></item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries.map((e) => e.id)).toEqual(["", ""]);
    expect(feed.entries.map((e) => e.content)).toEqual(["b1", "b2"]);
  });

  it("旧的『按节点对象身份去重』是空转代码：摘掉它不影响任何结果，所以判据换成解析后的 id", () => {
    // 两个 <item> 永远是不同对象，Set<OrderNode> 在约定制下不可能碰撞（变异实验：删掉那段 86 条无感）。
    // 这里钉住真正有判别力的那条：同 id 必须合成 1 条。
    const xml =
      "<rdf:RDF>" +
      '<item rdf:about="https://x/same"><title>A</title></item>' +
      '<item rdf:about="https://x/same"><title>B</title></item>' +
      "</rdf:RDF>";
    expect(parseFeed(xml).entries).toHaveLength(1);
  });

  it("Nature 固件（item 挂根下 + channel 内只有 items/rdf:Seq）仍是 75 条且 id 不重复", () => {
    const feed = parseFeed(natureRdf);
    expect(feed.entries).toHaveLength(75);
    expect(new Set(feed.entries.map((e) => e.id)).size).toBe(75);
  });
});

/* ================== 第三轮回归：文本清洗（N3 N5 N6） ================== */

/** 把一个正文片段塞进 RSS item 的 description（CDATA 包裹，内容原样进入清洗管线） */
function feedWithDescription(body: string): string {
  return (
    '<rss version="2.0"><channel><title>T</title><item><title>I</title>' +
    "<description><![CDATA[" +
    body +
    "]]></description></item></channel></rss>"
  );
}

function contentOf(body: string): string {
  return parseFeed(feedWithDescription(body)).entries[0].content;
}



describe("N3 script/style 大小写混排（回归：JS/CSS 正文泄漏）", () => {
  const cases: Array<[string, string, string]> = [
    ["全大写", "<SCRIPT>var leak=1;</SCRIPT>", "leak"],
    ["首字母大写", "<Script>y(leaky())</Script>", "leaky"],
    ["开标签大写闭标签小写", "<SCRIPT>W(leak())</script>", "leak"],
    ["开标签小写闭标签大写", "<script>q(leak())</SCRIPT>", "leak"],
    ["STYLE 全大写", "<STYLE>.x{color:red}</STYLE>", "color:red"],
    ["Style 混合", "<Style>a{leak:1}</style>", "leak"],
    ["带属性的混合大小写开标签", '<SCRIPT type="text/javascript">var leak=1;</SCRIPT>', "leak"],
  ];
  for (const [name, snippet, needle] of cases) {
    it(`${name}：script/style 整块必须被吞掉`, () => {
      const content = contentOf(`A ${snippet} B`);
      expect(content).toBe("A B");
      expect(content).not.toContain(needle);
    });
  }

  it("同一 item 内多块混排大小写的 script/style 都不泄漏", () => {
    const content = contentOf(
      "<p>P1</p><STYLE>BODY{background:leak}</STYLE><p>P2</p><SCRIPT>var x='leak';</SCRIPT><p>P3</p>",
    );
    expect(content).toBe("P1 P2 P3");
    expect(content).not.toMatch(/leak/);
  });

  it("小写形态（此前已正常）继续正确 —— 防修反", () => {
    expect(contentOf("A <script>var ok=1;</script> B")).toBe("A B");
    expect(contentOf("A <style>.a{x}</style> B")).toBe("A B");
  });
});

describe("N5 字面尖括号文本不再被改写（比较/数学语义）", () => {
  it("`<` 后是空格/数字/运算符时按普通文本保留，句子不被改写", () => {
    expect(contentOf("if (a &lt; b and c &gt; d) return")).toBe("if (a < b and c > d) return");
    expect(contentOf("a &lt; b > c")).toBe("a < b > c");
    expect(contentOf("x < 5 && y > 3")).toBe("x < 5 && y > 3");
    expect(contentOf("1 < 2")).toBe("1 < 2");
  });

  it("真标签形态仍然照剥（N5 只放宽字面文本，不放行标签）", () => {
    expect(contentOf("see <div>inner</div> end")).toBe("see inner end");
    expect(contentOf("<!-- 注释 -->keep")).toBe("keep");
    expect(contentOf("<b>bold</b> tail")).toBe("bold tail");
  });

  it("清洗后不得残留标签形态（不变式与实现共用同一把尺子 findMarkupStart）", () => {
    for (const body of [
      "if (a &lt; b and c &gt; d) return",
      "see <div>x</div>",
      "a < b > c",
      "<b>bold</b> tail",
    ]) {
      expectNoMarkup(contentOf(body), `清洗结果（输入 ${body}）`);
    }
  });
});

describe("N6 相邻元素文本之间必须有分隔（不再粘连）", () => {
  it("Atom xhtml 的 <p>Alpha</p><p>Beta</p> → Alpha Beta", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>e1</id>' +
      '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Alpha</p><p>Beta</p></div></content>' +
      "</entry></feed>";
    expect(parseFeed(xml).entries[0].content).toBe("Alpha Beta");
  });

  it("列表项 <li>one</li><li>two</li> → one two（不再 onetwo）", () => {
    expect(contentOf("<ul><li>one</li><li>two</li></ul>")).toBe("one two");
  });

  it("元素与紧邻文本混排不重复加空格", () => {
    expect(contentOf("Hello <b>world</b> !")).toBe("Hello world !");
  });

  it("同一口径也作用于 title（结构路径与标记路径一致）", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>' +
      "<entry><id>e1</id><title><span>A</span><span>B</span></title></entry></feed>";
    expect(parseFeed(xml).entries[0].title).toBe("A B");
  });
});

/* ================== 第三轮回归：条目取舍 / id 规格 / 时间（N4 N7） ================== */

describe("N4/M-B 空条目过滤：有【非空身份值】才保留（时间字段不算身份）", () => {
  it("只有 guid 的 item 必须保留，id 取 guid", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title>' +
      "<item><guid>only-guid</guid></item>" +
      "</channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("only-guid");
  });

  it("播客纯音频 item（空 guid + pubDate + enclosure）必须保留，id 退到 enclosure", () => {
    const xml =
      '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">' +
      "<channel><title>Pod</title>" +
      '<item><guid isPermaLink="false"></guid>' +
      "<pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate>" +
      '<enclosure url="https://cdn/ep1.mp3" type="audio/mpeg" length="123"/>' +
      "</item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("https://cdn/ep1.mp3");
    expect(feed.entries[0].publishedAt).toBeInstanceOf(Date);
  });

  it("Atom 只声明空 <id/> 与空 <updated/> 的 entry 【被过滤】（值为空不算身份；时间字段更不是身份）", () => {
    // 【第四轮 M-B 反转口径】第三轮的判据是"字段被声明过就保留 + 时间字段算身份"，
    // 结果这类条目全部留下并批量产出 id=""，恰与实现注释声称的"防下游按空 id 互相覆盖"相反。
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>' +
      "<entry><id></id><updated></updated></entry>" +
      "</feed>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(0);
  });

  it("身份字段有【非空值】才保留：非空 <id> 的 Atom entry 照常留且 id 取它", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>' +
      "<entry><id>atom-1</id><updated></updated></entry>" +
      "</feed>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("atom-1");
  });

  it("真正完全空白的 <item/> / <entry/> 仍被过滤（不误留）", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item></item><item/>' +
      "<item><title>keep</title></item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries.map((e) => e.id)).toEqual(["keep"]);

    const atom =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry/><entry><title>K</title></entry></feed>';
    expect(parseFeed(atom).entries.map((e) => e.id)).toEqual(["K"]);
  });

  it("只有 RDF 元数据（rdf:about / dc:identifier）的 item 也保留，并按优先级取 id", () => {
    const withAbout =
      '<rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">' +
      '<item rdf:about="https://x/1"><dc:identifier>doi:10.1/abc</dc:identifier></item>' +
      "</rdf:RDF>";
    const feed = parseFeed(withAbout);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("https://x/1"); // rdf:about 排在 dc:identifier 前

    const onlyDc =
      '<rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      "<item><dc:identifier>doi:10.1/abc</dc:identifier></item>" +
      "</rdf:RDF>";
    expect(parseFeed(onlyDc).entries[0].id).toBe("doi:10.1/abc");
  });
});

describe("id 优先级规格 guid → link → title（此前零覆盖，本轮补上）", () => {
  it("三者齐备时 id 取 guid", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      "<title>The Title</title><link>https://x/link</link><guid>THE-GUID</guid>" +
      "</item></channel></rss>";
    expect(parseFeed(xml).entries[0].id).toBe("THE-GUID");
  });

  it("Atom 三者齐备时 id 取 <id>", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry>' +
      "<title>The Title</title><link href=\"https://x/link\"/><id>ATOM-ID</id>" +
      "</entry></feed>";
    expect(parseFeed(xml).entries[0].id).toBe("ATOM-ID");
  });

  it("无 guid 时取 link（不得跳过 link 直接用 title）", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      "<title>The Title</title><link>https://x/link</link>" +
      "</item></channel></rss>";
    expect(parseFeed(xml).entries[0].id).toBe("https://x/link");
  });

  it("只有 title 时才退化为 title", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item><title>Only Title</title></item></channel></rss>';
    expect(parseFeed(xml).entries[0].id).toBe("Only Title");
  });

  it("空 guid / 空白 guid 不算身份，继续退到 link", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      "<title>The Title</title><link>https://x/link</link><guid>   </guid>" +
      "</item></channel></rss>";
    expect(parseFeed(xml).entries[0].id).toBe("https://x/link");
  });
});

describe("时间字段：解析失败置 undefined 不抛错；多时间源逐个试解析（N7）", () => {
  it("<pubDate>not a date</pubDate> → publishedAt 为 undefined 且不抛错", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      "<title>I</title><pubDate>not a date</pubDate>" +
      "</item></channel></rss>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.publishedAt).toBeUndefined();
    expect("publishedAt" in entry).toBe(false);
  });

  it("RDF dc:date 支路能解析出时间（固件只有 pubDate/published 之外的那一支）", () => {
    const xml =
      '<rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/"><item>' +
      "<title>I</title><dc:date>2024-03-04T05:06:07Z</dc:date>" +
      "</item></rdf:RDF>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.publishedAt).toBeInstanceOf(Date);
    expect(entry.publishedAt!.toISOString()).toBe("2024-03-04T05:06:07.000Z");
  });

  it("Nature 固件条目经 dc:date 支路拿到有效时间", () => {
    const feed = parseFeed(natureRdf);
    expect(feed.entries).toHaveLength(75);
    for (const entry of feed.entries) {
      expect(entry.publishedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(entry.publishedAt!.getTime())).toBe(false);
    }
  });

  it("Atom updated 支路（无 published 时用 updated）", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>' +
      "<entry><id>e</id><title>U</title><updated>2023-07-08T09:10:11Z</updated></entry></feed>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.publishedAt).toBeInstanceOf(Date);
    expect(entry.publishedAt!.toISOString()).toBe("2023-07-08T09:10:11.000Z");
  });

  it("N7 RSS：坏 pubDate + 好 dc:date → 逐个试解析，取到有效时间", () => {
    const xml =
      '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>T</title><item>' +
      "<title>I</title><pubDate>垃圾时间</pubDate><dc:date>2024-05-06T07:08:09Z</dc:date>" +
      "</item></channel></rss>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.publishedAt).toBeInstanceOf(Date);
    expect(entry.publishedAt!.toISOString()).toBe("2024-05-06T07:08:09.000Z");
  });

  it("N7 Atom：坏 published + 好 updated → 取 updated", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>' +
      "<entry><id>e</id><published>Yesterday-ish</published><updated>2022-01-02T03:04:05Z</updated></entry></feed>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.publishedAt).toBeInstanceOf(Date);
    expect(entry.publishedAt!.toISOString()).toBe("2022-01-02T03:04:05.000Z");
  });

  it("全部时间源都无效 → undefined（不抛错、不用 Date.now 兜底）", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      "<title>I</title><pubDate>nope</pubDate><dc:date>also nope</dc:date>" +
      "</item></channel></rss>";
    expect(parseFeed(xml).entries[0].publishedAt).toBeUndefined();
  });
});

/* ================== 第三轮：上限口径 / 边界形态 / N9 / N3 配套 / N8 ================== */

describe("P1 输入上限口径：按 UTF-8 字节计（CJK feed 不再被放行约 3 倍体积）", () => {
  it("导出字节上限 = 8 MiB，字符上限只作前置快速拒绝", () => {
    expect(MAX_FEED_INPUT_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_FEED_INPUT_CHARS).toBe(8 * 1024 * 1024);
  });

  it("3M 个 CJK 字符（约 9MB UTF-8）：字符口径放行，字节口径必须拒绝", () => {
    // 故意做成"截断的 feed"：旧口径下它会一路走到 XML 解析（实测约 2.5s / +145MB），
    // 修复后必须在解析之前就被挡下，报 FeedInputTooLargeError。
    const big = "<rss>" + "中".repeat(3 * 1024 * 1024);
    expect(big.length).toBeLessThan(MAX_FEED_INPUT_CHARS); // 旧口径（纯字符数）放过它
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_FEED_INPUT_BYTES); // 新口径拦下它
    expect(() => parseFeed(big)).toThrowError(FeedInputTooLargeError);
  });

  it("超限报错文案给出字节数与上限", () => {
    const big = "<rss>" + "中".repeat(3 * 1024 * 1024);
    let caught: unknown = null;
    try {
      parseFeed(big);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FeedInputTooLargeError);
    // 第七轮 item1：原来的关键字钉（/字节/、/上限/）换成模板锚定 ——
    // "已达→达到"这类同义替换、以及语序重排、删尾注，改一个字必红。
    // 上限值是模板里的字面量（绑定导出常量），报出的字节数是捕获组，另核对它等于真实预算数。
    const [bytesReported] = expectMessageTemplate(
      (caught as Error).message,
      PIN_TOO_LARGE_BYTES,
      "原始字节超限文案",
    );
    expect(bytesReported).toBe(Buffer.byteLength(big, "utf8")); // 报的必须是真正计入预算的那个数
  });

  it("1.2M 个 CJK 字符（约 3.6MB）在 8MiB 预算内：不得被体积上限误杀", () => {
    const ok =
      '<rss version="2.0"><channel><title>' + "中".repeat(1200000) + "</title></channel></rss>";
    expect(() => parseFeed(ok)).not.toThrowError(FeedInputTooLargeError);
    const feed = parseFeed(ok);
    expect(feed.entries).toHaveLength(0);
    expect(feed.title.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("边界形态（本轮实测口径钉桩，含已知残留，见各用例注释）", () => {
  it("HTML 块/标签大小写不敏感：大写标签与大写实体都能处理", () => {
    expect(contentOf("<DIV>x</DIV> y")).toBe("x y");
    expect(contentOf("one<BR/>two")).toBe("one two");
    expect(contentOf("set &LT;div&gt; ok")).toBe("set ok");
    expect(contentOf("&amp;lt;script&amp;gt;leak()&amp;lt;/script&amp;gt; done")).toBe("done");
  });

  it("字面 '<' 形态全谱：'<<' / '<=' / '<3' / 串尾孤立 '<' 都原样保留", () => {
    expect(contentOf("a << b")).toBe("a << b");
    expect(contentOf("if (a <= b) {}")).toBe("if (a <= b) {}");
    expect(contentOf("<3 CJK")).toBe("<3 CJK");
    expect(contentOf("abc <")).toBe("abc <");
  });

  it("已知残留（不假装完美）：'<' 后是标签形态但全串再无 '>' 时，尾巴按字面保留", () => {
    // 第 2 轮既有口径（无 '>' 闭合 → 视为字面文本），本轮未改；
    // 代价是这种尾巴会留下 `<b` 这类标签形态。三个真实固件都不出现该形态（已断言 0 残留）。
    expect(contentOf("text <b")).toBe("text <b");
  });

  it("结构标签大小写敏感：<RSS><CHANNEL><ITEM> 不认作 feed（XML 本身大小写敏感，刻意不归一）", () => {
    expect(() => parseFeed("<RSS><CHANNEL><TITLE>T</TITLE><ITEM><TITLE>A</TITLE></ITEM></CHANNEL></RSS>")).toThrowError(
      NotAFeedError,
    );
  });

  it("前缀化时间/正文源：atom:updated、atom:content 走本地名口径", () => {
    const xml =
      '<feed xmlns:a="http://www.w3.org/2005/Atom"><a:title>T</a:title>' +
      "<a:entry><a:id>i</a:id><a:title>x</a:title>" +
      "<a:updated>2021-01-01T00:00:00Z</a:updated>" +
      "<a:content>body text</a:content></a:entry></feed>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.publishedAt?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
    expect(entry.content).toBe("body text");
  });

  it("media:* 既不当链接也不当正文：link 空、id 退到 title", () => {
    const xml =
      '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title>' +
      '<item><title>x</title><media:content url="https://v/x.mp4"/></item></channel></rss>';
    const entry = parseFeed(xml).entries[0];
    expect(entry.link).toBe("");
    expect(entry.id).toBe("x");
    expect(entry.content).toBe("");
  });
});

describe("N9 C0 控制字符不得进入纯文本（污染入库/JSON）", () => {
  const C0 = [1, 7, 11, 31].map((c) => String.fromCharCode(c));
  const DEL = String.fromCharCode(0x7f);

  it("剥离 C0（除空白类）与 DEL，正文只剩可读文本", () => {
    const content = contentOf(
      "A" + C0[0] + " B" + C0[1] + "C" + C0[2] + " D" + C0[3] + " E" + DEL,
    );
    expect(content).toBe("A B C D E");
    // 输出里不得留任何 C0/DEL（空格 0x20 是允许的）
    expect(Array.from(content).every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
  });

  it("title 同样清洗：控制字符按【分隔符】处理（不制造粘连 token）", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      "<title>We" + C0[1] + "ird</title><description>d</description>" +
      "</item></channel></rss>";
    // 口径说明：这里得到 "We ird" 而不是 "Weird"——控制字符不是词内合法字符，
    // 按分隔符处理才不会造出 alphabeta 这类粘连脏 token（与 N6 同一条理由）。
    expect(parseFeed(xml).entries[0].title).toBe("We ird");
  });
});

describe("N3 配套：开标签未闭合的 script/style（可辩护取舍，行为在此钉住）", () => {
  it("全串无闭合时只吃掉开标签本身，残留 JS/CSS 属可辩护取舍（口径见实现注释）", () => {
    expect(contentOf("A <style>.x{color:red}")).toBe("A .x{color:red}");
    expect(contentOf("A <script>var x=1;")).toBe("A var x=1;");
  });
});

describe("N8 RDF item 无 link 时的 id 兜底（不再退化成 title）", () => {
  it("有 rdf:about 时 id 取 about URI，而不是 title", () => {
    const xml =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">' +
      '<item rdf:about="https://x/stable-1"><title>会变的标题</title></item>' +
      "</rdf:RDF>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.link).toBe("");
    expect(entry.id).toBe("https://x/stable-1");
  });

  it("无 about、有 dc:identifier 时 id 取 dc:identifier", () => {
    const xml =
      '<rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      "<item><title>T</title><dc:identifier>doi:10.2/xyz</dc:identifier></item>" +
      "</rdf:RDF>";
    expect(parseFeed(xml).entries[0].id).toBe("doi:10.2/xyz");
  });

  it("link 存在时优先于 rdf:about（新兜底源不得抢位）", () => {
    const xml =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">' +
      '<item rdf:about="https://x/about"><title>T</title><link>https://x/link</link></item>' +
      "</rdf:RDF>";
    expect(parseFeed(xml).entries[0].id).toBe("https://x/link");
  });

  it("Nature 固件：id 仍等于 link（新兜底源没改既有主键口径）", () => {
    const feed = parseFeed(natureRdf);
    expect(feed.entries).toHaveLength(75);
    for (const entry of feed.entries) {
      expect(entry.id).toBe(entry.link);
    }
  });
});


/* ==================================================================================
 * 第四轮必修 M-A / M-B / M-C + 应修项（统一尺子 / 去重判据 / 多 channel / 断言补齐）
 * ================================================================================== */

const AMP_HEAD =
  '<rss version="2.0"><channel><title>T</title><item><title>I</title><description><![CDATA[';
const AMP_TAIL = "]]></description></item></channel></rss>";
/** 裸 & 洪泛：完全合法、会被规范化的输入，每个 '&' 放大成 '&amp;'（1→5 字节） */
function ampFlood(amps: number): string {
  return AMP_HEAD + "&".repeat(amps) + AMP_TAIL;
}

describe("M-A 体积预算按【实际要解析的串】计（裸 & 规范化不再能 5 倍绕过上限）", () => {
  it("RED 复现档位：裸 & 洪泛规范化后【仍在预算内】⇒ 必须放行（不误杀；2MiB/4MiB/贴上限档见下）", () => {
    // 档位取 0.5MiB 个 '&'（规范化后约 2.5MB）：本机是 2C/7.6G 常驻容器且另有子代理在跑，
    // 1MiB 档要解析 5MB（空闲 1.9s / 高负载 10.4s），换成 0.5MiB 同样钉住"预算内放行"这条口径。
    const amps = Math.round(0.5 * 1024 * 1024);
    const xml = ampFlood(amps);
    const rawBytes = utf8ByteLength(xml);
    expect(rawBytes).toBeLessThan(MAX_FEED_INPUT_BYTES);
    expect(rawBytes + 4 * amps).toBeLessThan(MAX_FEED_INPUT_BYTES);
    expect(() => parseFeed(xml)).not.toThrowError(FeedInputTooLargeError);
    expect(parseFeed(xml).entries[0].content).toHaveLength(amps);
  }, 30_000);

  it("2MiB 个裸 & —— 原始 2MiB（旧口径放行），规范化后约 10MB 超 8MiB ⇒ 必须拒", () => {
    const xml = ampFlood(2 * 1024 * 1024);
    expect(utf8ByteLength(xml)).toBeLessThan(MAX_FEED_INPUT_BYTES); // 前置字节校验放过它
    expect(() => parseFeed(xml)).toThrowError(FeedInputTooLargeError);
  }, 30_000);

  it("4MiB 个裸 & —— 规范化后约 20MB ⇒ 必须拒", () => {
    const xml = ampFlood(4 * 1024 * 1024);
    expect(utf8ByteLength(xml)).toBeLessThan(MAX_FEED_INPUT_BYTES);
    expect(() => parseFeed(xml)).toThrowError(FeedInputTooLargeError);
  }, 30_000);

  it("贴 8MiB 上限的裸 & 洪泛（旧口径恰好放行 → 40MB 进解析器）⇒ 必须拒", () => {
    const amps = MAX_FEED_INPUT_BYTES - utf8ByteLength(AMP_HEAD) - utf8ByteLength(AMP_TAIL);
    const xml = ampFlood(amps);
    // 原始字节【恰好不超】上限：这就是旧实现被绕过的入口
    expect(utf8ByteLength(xml)).toBe(MAX_FEED_INPUT_BYTES);
    // 规范化后是 5 倍体积
    expect(utf8ByteLength(xml) + 4 * amps).toBeGreaterThan(4 * MAX_FEED_INPUT_BYTES);
    expect(() => parseFeed(xml)).toThrowError(FeedInputTooLargeError);
  }, 30_000);

  it("放大越界的报错文案同时给出字节数与上限，并说明是规范化放大导致", () => {
    let caught: unknown = null;
    try {
      parseFeed(ampFlood(4 * 1024 * 1024));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FeedInputTooLargeError);
    const message = (caught as Error).message;
    // 第七轮 item1：原来四条关键字钉（/字节/ /上限/ 数字串 /规范化/）换成一条模板锚定。
    // 锚定本身就要求"字节 / 上限 / 规范化 / 8388608 / 括号标点"逐字在场且【顺序正确】，
    // 比那几个关键字的并集强得多——同义替换（已达→达到）、重排（超过上限 X 字节 ↔
    // X 字节超过上限）、删尾注（去掉"——原始输入本身未超限…"）都会立刻红。
    const [bytesReported] = expectMessageTemplate(
      message,
      PIN_TOO_LARGE_NORMALIZED,
      "规范化放大越界文案",
    );
    // 报出的累计字节数必须落在"首次越过上限"那一格：规范化每遇一个裸 & 至多 +5 字节，
    // 越界立即中止（不是先把 40MB 构造完再数字节），故超出量必在 (0, 5] 内。
    expect(bytesReported).toBeGreaterThan(MAX_FEED_INPUT_BYTES);
    expect(bytesReported).toBeLessThanOrEqual(MAX_FEED_INPUT_BYTES + 5);
  });

  it("超大【原始】输入走前置拒绝（文案是原始超限，不是规范化超限）——不为规范化把大串读进来", () => {
    const huge = "<rss>" + "&".repeat(MAX_FEED_INPUT_BYTES + 10);
    expect(utf8ByteLength(huge)).toBeGreaterThan(MAX_FEED_INPUT_BYTES);
    let caught: unknown = null;
    try {
      parseFeed(huge);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FeedInputTooLargeError);
    expect((caught as Error).message).not.toMatch(/规范化/);
    // 第七轮 item1：这条串的字符数就已越过前置上限 ⇒ 命中的是【字符数快速拒绝】那条文案，
    // 钉住它逐字等于模板（并确认它不是规范化文案），"前置拒绝不念放大文案"才算真钉住。
    const [charsReported] = expectMessageTemplate(
      (caught as Error).message,
      PIN_TOO_LARGE_CHARS,
      "前置拒绝文案（字符数口径）",
    );
    expect(charsReported).toBe(huge.length);
    expect(PIN_TOO_LARGE_NORMALIZED.test((caught as Error).message)).toBe(false);
  }, 30_000);

  it("字符数前置上限仍然先拦：超限输入不必再数字节", () => {
    const over = "<rss>" + "a".repeat(MAX_FEED_INPUT_CHARS + 1);
    let caught: unknown = null;
    try {
      parseFeed(over);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FeedInputTooLargeError);
    // 第七轮 item1：/字符/ 关键字钉换成模板锚定，并核对报出的字符数就是越界的那个数。
    const [charsReported] = expectMessageTemplate(
      (caught as Error).message,
      PIN_TOO_LARGE_CHARS,
      "字符数前置上限文案",
    );
    expect(charsReported).toBe(over.length);
  }, 30_000);

  it("反向对照（不误杀）：约 6MiB 的正常 ASCII 文档（含少量 &amp;）照样解析", () => {
    const body = "x".repeat(Math.floor(6 * 1024 * 1024));
    const xml =
      '<rss version="2.0"><channel><title>T</title><item><guid>big-one</guid>' +
      "<description>" +
      body +
      " &amp; tail</description></item></channel></rss>";
    expect(utf8ByteLength(xml)).toBeLessThan(MAX_FEED_INPUT_BYTES);
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("big-one");
    expect(feed.entries[0].content.length).toBeGreaterThan(5.5 * 1024 * 1024);
  }, 30_000);

  it("反向对照（不误杀）：含少量裸 & 的正常 feed 不被规范化复检拦下", () => {
    const xml =
      '<rss version="2.0"><channel><title>T</title><item><title>I</title>' +
      "<link>https://x/a?b=1&c=2</link><description>d &amp; e</description></item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].link).toBe("https://x/a?b=1&c=2");
  });
});

describe("M-B 条目取舍：身份判据=有非空值；时间字段一律不参与；空 id + 全空一律过滤", () => {
  const rss = (items: string) =>
    '<rss version="2.0"><channel><title>T</title>' + items + "</channel></rss>";

  it("只有 pubDate 的 item 被过滤（时间字段被当成身份 = 上一轮的反向缺陷）", () => {
    const feed = parseFeed(rss("<item><pubDate>Tue, 29 Sep 2026 09:21:01 GMT</pubDate></item>"));
    expect(feed.entries).toHaveLength(0);
  });

  it("空 <guid></guid> 的 item 被过滤（声明过 ≠ 有值）", () => {
    expect(parseFeed(rss("<item><guid></guid></item>")).entries).toHaveLength(0);
    expect(parseFeed(rss('<item><guid isPermaLink="false"></guid></item>')).entries).toHaveLength(0);
    expect(parseFeed(rss("<item><guid>   </guid></item>")).entries).toHaveLength(0);
  });

  it("无 url 的空 <enclosure/> 被过滤（enclosure 只有带上非空 url 才是身份）", () => {
    expect(parseFeed(rss("<item><enclosure/></item>")).entries).toHaveLength(0);
    expect(parseFeed(rss('<item><enclosure url=""/></item>')).entries).toHaveLength(0);
    expect(parseFeed(rss('<item><enclosure url="   "/></item>')).entries).toHaveLength(0);
  });

  it("四种时间字段（pubDate/date/published/updated）单独存在时全部被过滤", () => {
    expect(parseFeed(rss("<item><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate></item>")).entries).toHaveLength(0);
    expect(
      parseFeed(
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>T</title>' +
          "<item><dc:date>2024-01-01T00:00:00Z</dc:date></item></channel></rss>",
      ).entries,
    ).toHaveLength(0);
    const atom =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><updated>2024-01-01T00:00:00Z</updated></entry>' +
      "<entry><published>2024-01-01T00:00:00Z</published></entry></feed>";
    expect(parseFeed(atom).entries).toHaveLength(0);
  });

  it("20 个空 guid 条目 + 1 条真条目 ⇒ n=1（上一轮这里是 n=21，其中 20 条 id=\"\"）", () => {
    const feed = parseFeed(rss("<item><guid></guid></item>".repeat(20) + "<item><title>Real</title></item>"));
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("Real");
    expect(feed.entries.filter((e) => !e.id)).toHaveLength(0);
  });

  it("批量空壳（空 guid / 空 enclosure / 只有日期）混在一起 ⇒ 一条不留、一个空 id 都不产出", () => {
    const junk =
      "<item><guid></guid></item>".repeat(5) +
      "<item><enclosure/></item>".repeat(5) +
      "<item><pubDate>Tue, 29 Sep 2026 09:21:01 GMT</pubDate></item>".repeat(5);
    expect(parseFeed(rss(junk)).entries).toHaveLength(0);
    const atomJunk =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>' +
      "<entry><id></id><updated>2024-01-01T00:00:00Z</updated></entry>".repeat(5) +
      "</feed>";
    expect(parseFeed(atomJunk).entries).toHaveLength(0);
  });

  it("有非空 guid 的条目仍保留且 id 正确（放宽方向不能被误改）", () => {
    const feed = parseFeed(rss("<item><guid>only-guid</guid></item>"));
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("only-guid");
  });

  it("播客纯音频条目（空 guid + pubDate + 非空 enclosure url）仍保留，id 取 enclosure url", () => {
    const xml =
      '<rss version="2.0"><channel><title>Pod</title><item>' +
      '<guid isPermaLink="false"></guid><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate>' +
      '<enclosure url="https://cdn/ep1.mp3" type="audio/mpeg"/></item></channel></rss>';
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("https://cdn/ep1.mp3");
  });

  it("只有正文（description）而没有任何身份的条目保留，id 为空串并如实记录（M-B 只规定『全空才过滤』）", () => {
    const feed = parseFeed(rss("<item><description>body only</description></item>"));
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].id).toBe("");
    expect(feed.entries[0].content).toBe("body only");
  });

  it("三个真实固件产出的条目 id 全部非空（旧口径下会混进空 id）", () => {
    for (const feed of [parseFeed(hnRss2), parseFeed(natureRdf), parseFeed(redditAtom)]) {
      expect(feed.entries.length).toBeGreaterThan(0);
      for (const entry of feed.entries) expect(entry.id.length).toBeGreaterThan(0);
    }
  });
});

describe("M-C 标识符出口（id / link）的紧凑清洗口径 —— 逐条钉死，禁止与散文口径『顺手统一』", () => {
  const rssItem = (inner: string) =>
    '<rss version="2.0"><channel><title>T</title><item>' + inner + "</item></channel></rss>";
  const idOf = (inner: string) => parseFeed(rssItem(inner)).entries[0].id;
  const linkOf = (inner: string) => parseFeed(rssItem("<title>t</title>" + inner)).entries[0].link;

  it("① 实体解码：&amp; 进 id / link 都被解开", () => {
    expect(idOf("<guid>https://x?a=1&amp;b=2</guid>")).toBe("https://x?a=1&b=2");
    expect(idOf("<guid>a&copy;b&#65;</guid>")).toBe("a©bA");
    expect(linkOf("<link>https://x?a=1&amp;b=2</link>")).toBe("https://x?a=1&b=2");
    expect(linkOf('<link href="https://x?a=1&amp;b=2"/>')).toBe("https://x?a=1&b=2");
  });

  it("② 剥标签但【不插】分隔符：标识符是主键，补空格等于换主键（N6 只作用于散文）", () => {
    expect(idOf("<guid>tag:x<b>1</b></guid>")).toBe("tag:x1");
    expect(idOf("<guid>tag:x&amp;lt;b&amp;gt;1&amp;lt;/b&amp;gt;</guid>")).toBe("tag:x1");
    // 第五轮 M-G 改动登记：数字开头伪标签不再被剥 ⇒ id 里会留着字面 <1abc>。
    // 上一轮期望 "idx" 建立在"数字开头也算名字"上；本轮为救 `1<2>0` / `List<T>` 换掉了那条口径。
    expect(idOf("<guid>id&amp;lt;1abc&amp;gt;x&amp;lt;/1abc&amp;gt;</guid>")).toBe("id<1abc>x</1abc>");
    expect(linkOf("<link>https://x/<b>y</b>z</link>")).toBe("https://x/yz");
    // 对照：散文口径同样输入必须插空格（两条口径刻意分开，不许"顺手统一"）
    expect(contentOf("word<b>bold</b>")).toBe("word bold");
  });

  it("③ trim：首尾换行/缩进剥净（真实 feed 常把 guid 写成多行）", () => {
    expect(idOf("<guid>\r\n  https://x/1  \n\t</guid>")).toBe("https://x/1");
    expect(linkOf("<link>\n   https://x/2   </link>")).toBe("https://x/2");
  });

  it("④ 词内连续空白折叠成一个空格（既不留 \\n 进主键，也不把 token 粘死）", () => {
    expect(idOf("<guid>a\n  \tb</guid>")).toBe("a b");
    expect(idOf("<guid>https://x?a=1&b=\n  tail</guid>")).toBe("https://x?a=1&b= tail");
  });

  it("⑤ 控制符【删除】（正文口径是换空格，标识符换空格会把 URL 劈成两段）", () => {
    expect(idOf("<guid>x\u0001y</guid>")).toBe("xy");
    expect(idOf("<guid>https://x?a=1&amp;b=\u0001tail</guid>")).toBe("https://x?a=1&b=tail");
    expect(idOf("<guid>a\u007fb\u0000c</guid>")).toBe("abc");
    expect(linkOf("<link>https://x\u0001y</link>")).toBe("https://xy");
    expect(linkOf('<link href="https://x\u0001y"/>')).toBe("https://xy");
    // 对照：散文口径把控制符换成空格（标识符是删除），两条规则各自钉死
    expect(
      parseFeed(rssItem("<title>We" + "\u0007" + "ird</title><description>d</description>")).entries[0].title,
    ).toBe("We ird");
  });

  it("⑥ 零宽字符删除", () => {
    expect(idOf("<guid>abc\u200bdef</guid>")).toBe("abcdef");
    expect(linkOf("<link>https://x\u200dy</link>")).toBe("https://xy");
  });

  it("⑦ rdf:about / dc:identifier / enclosure url 同样走这套紧凑口径", () => {
    const rdf =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<item rdf:about="https://x/\u00011"><dc:identifier>doi:10.1\u0002/a</dc:identifier></item></rdf:RDF>';
    expect(parseFeed(rdf).entries[0].id).toBe("https://x/1");
    const noAbout =
      '<rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/"><item><dc:identifier>doi:10.1\u0002/a</dc:identifier></item></rdf:RDF>';
    expect(parseFeed(noAbout).entries[0].id).toBe("doi:10.1/a");
    const pod =
      '<rss version="2.0"><channel><title>P</title><item><enclosure url="https://cdn/\u0001ep1.mp3"/></item></channel></rss>';
    expect(parseFeed(pod).entries[0].id).toBe("https://cdn/ep1.mp3");
  });

  it("⑧ 出口不变式：三个真实固件的每条 id/link 都满足紧凑清洗规则（无标记形态/无控制符/无双空格/无首尾空白）", () => {
    for (const feed of [parseFeed(hnRss2), parseFeed(natureRdf), parseFeed(redditAtom)]) {
      for (const entry of feed.entries) {
        for (const value of [entry.id, entry.link]) {
          if (!value) continue;
          expect(findMarkupStart(value)).toBe(-1);
          expect(/[\u0000-\u0008\u000e-\u001f\u007f\u200b\u200c\u200d\ufeff]/.test(value)).toBe(false);
          expect(/  /.test(value)).toBe(false);
          expect(value).toBe(value.trim());
        }
      }
    }
  });

  it("⑨ 迁移说明钉桩：id 口径就是这些断言的合取，上线后改口径=全量重复入库（此处先钉住）", () => {
    // 该用例把"当前口径"当成一份可执行规格集中断言一次，改动任何一条都会在这里变红。
    const xml =
      '<rss version="2.0"><channel><title>T</title><item>' +
      "<guid>\n  tag:x<b>1</b>&amp;\u0001tail  \n</guid></item></channel></rss>";
    expect(parseFeed(xml).entries[0].id).toBe("tag:x1&tail");
  });

  it("对照：散文出口（title）保持插空格 + 控制符换空格，未被标识符口径污染", () => {
    const entry = parseFeed(
      '<rss version="2.0"><channel><title>T</title><item><title>We\u0007ird<b>x</b></title></item></channel></rss>',
    ).entries[0];
    expect(entry.title).toBe("We ird x");
    // 【第六轮 item4 口径变更登记（不是悄悄改期望）】
    //  旧期望是 "We ird x"，它建立在"兜底拿的是【已按散文口径清洗过的 title】再过一遍标识符清洗"
    //  上——于是 id 里留着散文口径插进去的分隔空格，而 identityOf 的注释却声称"每个候选值都过
    //  toIdentifierText，所以 id 永远满足标识符清洗规则"（第四轮 M-C 的未闭项：注释与代码矛盾）。
    //  现在 title 兜底改成对【原始 title】跑标识符口径：元素之间不插分隔（"We ird x" → "Weirdx"），
    //  控制符删除而非换空格。散文出口 title 本身一字未变（上一条断言仍在）。
    //  为什么可以改：RSS 功能未上线 ⇒ 没有历史主键要迁；上线后这条链再动就是全量重复入库。
    expect(entry.id).toBe("Weirdx");
  });
});

describe("应修项1 剥标签与不变式共用同一把尺子（isWellFormedMarkupAt）", () => {
  it("尺子本身：属性必须带 =；`<b and c>`、`<max 且 b>`、`<<`、`<3 x` 都不是标记", () => {
    expect(isWellFormedMarkupAt("<div>", 0)).toBe(5);
    expect(isWellFormedMarkupAt("</div>", 0)).toBe(6);
    expect(isWellFormedMarkupAt('<a href="x">', 0)).toBe(12);
    expect(isWellFormedMarkupAt("<br/>", 0)).toBe(5);
    expect(isWellFormedMarkupAt("<!--c-->", 0)).toBe(8);
    expect(isWellFormedMarkupAt("<b and c>", 0)).toBe(-1);
    expect(isWellFormedMarkupAt("<max 且 b>", 0)).toBe(-1);
    expect(isWellFormedMarkupAt("<<", 0)).toBe(-1);
    expect(isWellFormedMarkupAt("<3 x", 0)).toBe(-1);
    expect(isWellFormedMarkupAt("<b", 0)).toBe(-1);
    expect(isWellFormedMarkupAt("a", 0)).toBe(-1);
  });

  it("尺子有界：跨度超过 MAX_MARKUP_SPAN 不算标记（因此『留下』与『不判红』同源）", () => {
    const long = "<" + "x".repeat(MAX_MARKUP_SPAN) + ">";
    expect(isWellFormedMarkupAt(long, 0)).toBe(-1);
    expect(findMarkupStart(long)).toBe(-1);
    expect(isWellFormedMarkupAt("<" + "x".repeat(10) + ">", 0)).toBe(12);
  });

  it("散文不被剥坏：`a<b and c>d` / `参数 a<max 且 b>min` 原样保住", () => {
    expect(contentOf("if (a<b and c>d) return true")).toBe("if (a<b and c>d) return true");
    expect(contentOf("参数 a<max 且 b>min 时成立")).toBe("参数 a<max 且 b>min 时成立");
    expect(contentOf("参数 a<max 且 b>min 时成立")).toBe("参数 a<max 且 b>min 时成立");
    // 与不变式自洽：这些留下的 '<' 不是 well-formed 标记，尺子两边同判
    expectNoMarkup(contentOf("if (a<b and c>d) return true"), "留下的散文尖括号");
    expectNoMarkup(contentOf("参数 a<max 且 b>min 时成立"), "中文散文尖括号");
  });

  it("50KB 正文不再被静默吞掉（旧实现给 'HEAD TAIL'，9 个字符）", () => {
    const content = contentOf("HEAD<b" + "x".repeat(50000) + ">TAIL");
    expect(content.length).toBeGreaterThan(40000);
    expect(content.startsWith("HEAD<b")).toBe(true);
    expect(content.endsWith(">TAIL")).toBe(true);
    // 同一条尺子：超长不算标记，所以断言也不会为此判红
    expect(findMarkupStart(content)).toBe(-1);
  });

  it("伪标签剥净口径（变异 A7；第五轮 M-G 改动：数字开头改判散文，`_`/`#` 开头仍剥净）", () => {
    // `_` / `#` 开头是合法名字首字符 ⇒ 与真标记一样剥净，不留能骗过两边的脏输出
    expect(contentOf("<_x>secret</_x>")).toBe("secret");
    expect(contentOf("<#if a==b#>tail")).toBe("tail");
    expect(isWellFormedMarkupAt("<_x>", 0)).toBe(4);
    expect(findMarkupStart("<_x>")).toBe(0);
    // 数字开头【改为】散文保留（有意取舍：`1<2>0` / `vector<int>` / `List<T>` 是真实内容，
    // 而数字开头的标签在 XML/HTML 里本就非法，现实 feed 不会出现）。
    // 完整登记与理由见 M-G 的【行为变化登记】用例。
    expect(contentOf("<1abc>secret</1abc>")).toBe("<1abc>secret</1abc>");
    expect(isWellFormedMarkupAt("<1abc>", 0)).toBe(-1);
    expect(findMarkupStart("<1abc>")).toBe(-1);
  });

  it("带引号/裸值属性的真标签照剥（尺子放行 XML 合法形态）", () => {
    expect(contentOf('x <div class="a b">y</div> z')).toBe("x y z");
    expect(contentOf("x <a href='q'>y</a> z")).toBe("x y z");
    expect(contentOf("x <a href=https://q>t</a> z")).toBe("x t z");
  });

  it("已知代价（如实记录，不假装完美）：多于一个裸属性时与散文无法区分，这类标签按字面保留", () => {
    // 第五轮 M-F 更正措辞：上一轮写的是"布尔属性与散文【语法上无法区分】"，那是 over-claim ——
    // `<input readonly>` 只有 1 个裸属性名，而散文里的 `a<b and c>d` 有 2 个，这个差别是可判的，
    // 尺子也正是按它分的（至多 1 个裸名 ⇒ 标记；第 2 个起 ⇒ 散文）。
    // 真正无法区分的只有"多于一个裸属性"这一档：本例 `<a href=x y z>` 与散文同形，
    // 尺子选择保住散文，代价是这类裸标签留在输出里 —— 因为尺子只有一把，
    // findMarkupStart 同样不判它是标记，实现与断言口径一致（不会互相打脸）。
    // 1 个裸属性的布尔标签现在会被剥净，见 M-F 的第一条用例；本例的准确归因是"2 个裸名（y、z）"。
    expect(contentOf("x <a href=x y z>y")).toBe("x <a href=x y z>y");
    expect(findMarkupStart(contentOf("x <a href=x y z>y"))).toBe(-1);
  });

  it("三个真实固件在统一尺子下标签形态残留为 0", () => {
    let checked = 0;
    for (const feed of [parseFeed(hnRss2), parseFeed(natureRdf), parseFeed(redditAtom)]) {
      for (const entry of feed.entries) {
        for (const value of [entry.title, entry.content, entry.summary, entry.id, entry.link]) {
          expectNoMarkup(value, "真实固件出口");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe("应修项4 N6 分隔符口径：该插才插、两侧对称，两条路径同一结果（变异 A2/A3）", () => {
  const struct = (inner: string) =>
    parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>e</id>' +
        '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">' +
        inner +
        "</div></content></entry></feed>",
    ).entries[0].content;

  it("该插的插：元素边界两侧都补分隔（旧版只补前侧 → 'A BC' / 'ABeta' 都不对称）", () => {
    expect(struct("A<b>B</b>C")).toBe("A B C");
    expect(struct("<p>A</p>Beta")).toBe("A Beta");
    expect(struct("word<b>bold</b>")).toBe("word bold");
    expect(struct("A<br/>B")).toBe("A B"); // 空元素同样产生分隔（旧版给 'AB'）
  });

  it("不该插的不插：已相邻空白时不重复补；纯文本节点之间不补；\s+ 归一保证无双空格", () => {
    expect(struct("Hello <b>world</b> !")).toBe("Hello world !");
    expect(struct("<p>Alpha </p><p> Beta</p>")).toBe("Alpha Beta");
    expect(struct("plain text only")).toBe("plain text only");
    for (const probe of ["A<b>B</b>C", "<p>A</p>Beta", "A<br/>B", "word<b>bold</b>"]) {
      expect(/  /.test(struct(probe))).toBe(false);
      expect(/  /.test(contentOf(probe))).toBe(false);
    }
  });

  it("两条路径（XML 结构 / CDATA 标记剥离）对同一段 HTML 给出【同一个】结果", () => {
    for (const probe of [
      "word<b>bold</b>",
      "A<b>B</b>C",
      "<p>A</p>Beta",
      "A<br/>B",
      "<p>Alpha</p><p>Beta</p>",
      "Hello <b>world</b> !",
      "<span>A</span><span>B</span>",
      "<ul><li>one</li><li>two</li></ul>",
    ]) {
      expect(struct(probe), `路径口径一致性：${probe}`).toBe(contentOf(probe));
    }
  });

  it("标识符出口不受 N6 影响：元素之间一律不插分隔（见 M-C ②）", () => {
    expect(struct("A<b>B</b>C")).toBe("A B C");
    expect(
      parseFeed(
        '<rss version="2.0"><channel><title>T</title><item><guid>A<b>B</b>C</guid></item></channel></rss>',
      ).entries[0].id,
    ).toBe("ABC");
  });
});

describe("应修项3 遍历全部 channel（旧实现只认第一个，第二个 channel 整批静默丢失）", () => {
  it("RSS 2.0 两个 channel 各带 1 个 item ⇒ n=2（实测旧行为给 n=1）", () => {
    const xml =
      "<rss><channel><title>C1</title><item><title>A</title></item></channel>" +
      "<channel><title>C2</title><item><title>B</title></item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries.map((e) => e.title)).toEqual(["A", "B"]);
  });

  it("三个 channel 共 5 个 item ⇒ 一条不漏", () => {
    const xml =
      "<rss>" +
      "<channel><title>C1</title><item><title>a1</title><link>https://x/1</link></item></channel>" +
      "<channel><title>C2</title><item><title>a2</title><link>https://x/2</link></item>" +
      "<item><title>a3</title><link>https://x/3</link></item></channel>" +
      "<channel><title>C3</title><item><title>a4</title><link>https://x/4</link></item></channel>" +
      "<item><title>a5</title><link>https://x/5</link></item>" +
      "</rss>";
    const feed = parseFeed(xml);
    expect(feed.entries.map((e) => e.title)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("多 channel 时 feed.title 取【文档顺序第一个】channel 的 title（上一轮只披露了一半，此处钉死）", () => {
    const xml =
      "<rss><channel><title>FIRST</title><item><title>A</title></item></channel>" +
      "<channel><title>SECOND</title><item><title>B</title></item></channel></rss>";
    expect(parseFeed(xml).title).toBe("FIRST");
  });

  it("前缀化 channel（rss:channel）同样被遍历", () => {
    const xml =
      '<rss xmlns:rss="http://purl.org/rss/1.0/"><rss:channel><title>C1</title><item><title>A</title></item></rss:channel>' +
      "<channel><title>C2</title><item><title>B</title></item></channel></rss>";
    expect(parseFeed(xml).entries.map((e) => e.title)).toEqual(["A", "B"]);
  });

  it("RDF 多 channel 行为不变（三 channel → n=3）", () => {
    const xml =
      "<rdf:RDF>" +
      "<channel><title>C1</title><item><title>A</title></item></channel>" +
      "<channel><title>C2</title><item><title>B</title></item></channel>" +
      "<channel><title>C3</title><item><title>C</title></item></channel></rdf:RDF>";
    expect(parseFeed(xml).entries).toHaveLength(3);
  });
});

describe("应修项4 单位级与整表遍历断言（补上活下来的变异面）", () => {
  it("utf8ByteLength 与 Buffer.byteLength 在每种 UTF-8 单位类型 + 边界上精确对齐", () => {
    const cases: Array<[string, string]> = [
      ["空串", ""],
      ["1 字节 ASCII", "a"],
      ["1 字节边界 NUL", "\u0000"],
      ["1/2 字节边界 0x7F/0x80", "\u007f\u0080"],
      ["2 字节", "¢"],
      ["2/3 字节边界 0x7FF/0x800", "\u07ff\u0800"],
      ["3 字节 CJK", "中"],
      ["3 字节 BMP 欧元", "€"],
      ["4 字节代理对", "\u{1F600}"],
      ["孤立高代理", "\ud83d"],
      ["孤立高代理+ASCII", "\ud83da"],
      ["末尾孤立低代理", "x\udc00"],
      ["代理对+孤立高代理", "\u{1F600}\ud83d"],
      ["混合", "a中\u{1F600}"],
      ["3 字节边界 0xFFFF", "\uffff"],
    ];
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const [name, s] of cases) {
      expect(utf8ByteLength(s), `单位口径 ${name}`).toBe(Buffer.byteLength(s, "utf8"));
    }
  });

  it("代理对少算/多算 1 字节都会被这条钉住：整串长度逐字符累加 = Buffer 口径", () => {
    const s = "🙂".repeat(1000) + "中".repeat(500) + "a".repeat(37);
    expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, "utf8"));
    expect(utf8ByteLength(s)).toBe(1000 * 4 + 500 * 3 + 37);
  });

  it("命名实体整表遍历：HTML_NAMED 每一项都必须被解码成表里的值（旧版只枚举 14/35 项）", () => {
    const entries = Object.entries(HTML_NAMED);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    for (const [name, decoded] of entries) {
      const content = contentOf(`X&${name};Y`);
      expect(content, `实体 &${name};`).toBe("X" + decoded + "Y");
      // 大小写不敏感
      expect(contentOf(`X&${name.toUpperCase()};Y`), `实体 &${name.toUpperCase()};`).toBe("X" + decoded + "Y");
    }
  });

  it("上一轮零覆盖的三个实体（euro / lsquo / deg）单独点名（变异 B16）", () => {
    expect(contentOf("a euro€ b")).toBe("a euro€ b");
    expect(contentOf("&euro;")).toBe("€");
    expect(contentOf("&lsquo;")).toBe("‘");
    expect(contentOf("&deg;")).toBe("°");
  });
});

/* ==================================================================================
 * 第五轮必修 M-H：feed.title 与"遍历全部 channel"必须自洽
 * ================================================================================== */

describe("M-H feed.title 取文档顺序【第一个非空】channel title（旧行为：只看第一个 channel，它没标题就给空串）", () => {
  it("复核原例：第一个 channel 无 title、第二个有 ⇒ feed.title 非空且 n=2（实测旧行为 title=\"\" 而 n=2，自相矛盾）", () => {
    const xml =
      "<rss><channel><item><title>i1</title></item></channel>" +
      "<channel><title>C2 有名字</title><item><title>i2</title></item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(2);
    expect(feed.title).toBe("C2 有名字");
  });

  it("两个 channel 都有 title ⇒ 仍取文档顺序第一个（口径不是『取最后一个』）", () => {
    const xml =
      "<rss><channel><title>FIRST</title><item><title>A</title></item></channel>" +
      "<channel><title>SECOND</title><item><title>B</title></item></channel></rss>";
    expect(parseFeed(xml).title).toBe("FIRST");
  });

  it("空 / 纯空白的 channel title 不算非空，继续往后找", () => {
    const xml =
      "<rss>" +
      "<channel><title></title><item><title>A</title></item></channel>" +
      "<channel><title>   </title><item><title>B</title></item></channel>" +
      "<channel><title>THIRD</title><item><title>C</title></item></channel>" +
      "</rss>";
    expect(parseFeed(xml).title).toBe("THIRD");
  });

  it("全部 channel 都没有 title ⇒ feed.title 为空串（绝不退回去抓 item 的 title）", () => {
    const xml =
      "<rss><channel><item><title>只属于条目</title></item></channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.title).toBe("");
  });

  it("RDF 多 channel 同样适用（前缀化 rss:channel 也算 channel）", () => {
    const xml =
      '<rdf:RDF xmlns:rss="http://purl.org/rss/1.0/">' +
      "<rss:channel><item><title>A</title></item></rss:channel>" +
      "<channel><title>真名</title><item><title>B</title></item></channel></rdf:RDF>";
    expect(parseFeed(xml).title).toBe("真名");
  });

  it("Atom 只有一个 feed/title，取它（不受 channel 口径改动影响）", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>ATOM-FEED</title>' +
      "<entry><id>e</id><title>T</title></entry></feed>";
    expect(parseFeed(xml).title).toBe("ATOM-FEED");
  });
});

/* ==================================================================================
 * 第五轮必修 M-E：同 id 合并必须是【字段并集】，不是覆盖式替换
 * ================================================================================== */

describe("M-E 同 id 合并=字段并集（旧行为是覆盖式替换，互补条目静默丢字段）", () => {
  it("复核原例：RDF 同 rdf:about 两条互补（A 只有 description，B 只有 title+pubDate）⇒ 三个出口都非空", () => {
    const xml =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">' +
      '<item rdf:about="https://x/complement"><description>只有正文的那一条</description></item>' +
      '<item rdf:about="https://x/complement"><title>只有标题的那一条</title>' +
      "<pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate></item></rdf:RDF>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    const entry = feed.entries[0];
    // 旧行为：两条完整度相同 → 保留先出现的一条 → B 的 title / pubDate 全丢
    expect(entry.title).toBe("只有标题的那一条");
    expect(entry.content).toBe("只有正文的那一条");
    expect(entry.summary).toBe("只有正文的那一条");
    expect(entry.publishedAt).toBeInstanceOf(Date);
    expect(entry.publishedAt!.toISOString()).toBe("2025-09-01T08:00:00.000Z");
    expect(entry.id).toBe("https://x/complement");
  });

  it("Atom 分支同 id 两条也走同一并集去重（第四轮此处的 dedupeById 调用被摘掉后 141 条全绿 = 零断言覆盖洞）", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>' +
      "<entry><id>ATOM-DUP</id><content>atom 只有正文</content></entry>" +
      "<entry><id>ATOM-DUP</id><title>atom 标题</title><link href=\"https://x/atom\"/>" +
      "<updated>2024-06-05T04:03:02Z</updated></entry></feed>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    const entry = feed.entries[0];
    expect(entry.title).toBe("atom 标题");
    expect(entry.link).toBe("https://x/atom");
    expect(entry.content).toBe("atom 只有正文"); // 胜出者的空槽必须由落选者回填
    expect(entry.publishedAt!.toISOString()).toBe("2024-06-05T04:03:02.000Z");
  });

  it("包含关系（一条是另一条的超集）⇒ 结果逐字段等于超集（并集不改变超集）", () => {
    const xml =
      "<rss><channel><title>C</title>" +
      "<item><guid>SUP</guid><title>lean</title></item>" +
      "<item><guid>SUP</guid><title>full</title><link>https://x/sup</link>" +
      "<description>body</description><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate></item>" +
      "</channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).toEqual({
      id: "SUP",
      title: "full",
      link: "https://x/sup",
      publishedAt: new Date("2025-09-01T08:00:00.000Z"),
      summary: "body",
      content: "body",
    });
  });

  it("等完整度（覆盖数与体量都相同）⇒ tie-break 取【先出现的】，并用断言钉住（不是只写在注释里）", () => {
    const xml =
      "<rss><channel><title>C</title>" +
      "<item><guid>TIE</guid><title>第一位</title><description>aaa</description></item>" +
      "<item><guid>TIE</guid><title>第二位</title><description>bbb</description></item>" +
      "</channel></rss>";
    const feed = parseFeed(xml);
    expect(feed.entries).toHaveLength(1);
    const entry = feed.entries[0];
    expect(entry.title).toBe("第一位"); // 冲突字段取先出现者
    expect(entry.content).toBe("aaa");
    expect(entry.summary).toBe("aaa");
  });

  it("时间计入完整度【权重】：胜出者由 title 冲突体现（去掉时间权重 → 平手 → 变成先出现者，此断言即红）", () => {
    const xml =
      "<rss><channel><title>C</title>" +
      "<item><guid>WEIGHT</guid><title>甲</title></item>" +
      "<item><guid>WEIGHT</guid><title>乙</title><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate></item>" +
      "</channel></rss>";
    const entry = parseFeed(xml).entries[0];
    // 第二条覆盖数 2（title + publishedAt）> 第一条 1（title）⇒ 以第二条为底，冲突的 title 取"乙"
    expect(entry.title).toBe("乙");
    expect(entry.publishedAt).toBeInstanceOf(Date);
  });

  it("覆盖数相同时用【正文体量】做第二判据：体量大的胜出（不计体量 → 平手 → 先出现者胜，此断言即红）", () => {
    const xml =
      "<rss><channel><title>C</title>" +
      "<item><guid>VOL</guid><title>短的</title><description>tiny</description></item>" +
      "<item><guid>VOL</guid><title>长的</title><description>" + "x".repeat(40) + "</description></item>" +
      "</channel></rss>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.title).toBe("长的");
    expect(entry.content).toHaveLength(40);
  });

  it("合并后的位置仍取【首次出现】的下标（不因胜出者在后而挪位）", () => {
    const xml =
      "<rss><channel><title>C</title>" +
      "<item><guid>Z1</guid><title>one</title></item>" +
      "<item><guid>DUP</guid><title>lean</title></item>" +
      "<item><guid>DUP</guid><title>Full</title><description>body</description></item>" +
      "<item><guid>Z2</guid><title>three</title></item>" +
      "</channel></rss>";
    expect(parseFeed(xml).entries.map((e) => e.id)).toEqual(["Z1", "DUP", "Z2"]);
    expect(parseFeed(xml).entries[1].title).toBe("Full");
  });

  it("空槽回填覆盖 link：先出现的一条没有 link，后一条有 ⇒ 合并结果拿到 link", () => {
    const xml =
      "<rss><channel><title>C</title>" +
      "<item><guid>FILL</guid><title>甲</title></item>" +
      "<item><guid>FILL</guid><link>https://x/fill</link></item>" +
      "</channel></rss>";
    const entry = parseFeed(xml).entries[0];
    expect(entry.link).toBe("https://x/fill");
    expect(entry.title).toBe("甲"); // 第一条覆盖数 1（title）+ 第二条覆盖数 2（link+? ）→ 见注释口径
  });

  it("三个固件的同 id 并集不改变条目数（20/75/25 与 id 唯一性仍成立）", () => {
    for (const feed of [parseFeed(hnRss2), parseFeed(natureRdf), parseFeed(redditAtom)]) {
      const ids = feed.entries.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("并集的两条键/槽位不变式：合并结果的 id 必须仍是那个键；两边都没时间就不许设 publishedAt 键", () => {
    // ① id 不漂移：mergeEntryFields 的 id 取【底】，而底与落选者的 id 必然同为这个碰撞键，
    //    所以这条今天无法用变异区分（等价变异），但它把"键就是键、不许被换成别的身份"写死，
    //    将来若有人改成按规范化 key 碰撞（trim/大小写折叠），漂移就会在这里暴露。
    const merged = parseFeed(
      "<rss><channel><title>C</title>" +
        "<item><guid>K1</guid><description>只有正文</description></item>" +
        "<item><guid>K1</guid><title>只有标题</title></item>" +
        "</channel></rss>",
    ).entries;
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("K1");
    expect(merged[0].title).toBe("只有标题");
    expect(merged[0].content).toBe("只有正文");
    // ② 两边都缺时间 ⇒ 整个键【不存在】（不是值为 undefined）：下游 JSON 序列化/按 in 判定都依赖它
    expect("publishedAt" in merged[0]).toBe(false);
    const oneSided = parseFeed(
      "<rss><channel><title>C</title>" +
        "<item><guid>K2</guid><title>甲</title></item>" +
        "<item><guid>K2</guid><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate></item>" +
        "</channel></rss>",
    ).entries;
    expect(oneSided[0].publishedAt).toBeInstanceOf(Date);
    expect(oneSided[0].title).toBe("甲"); // 时间只补空位，不许把底换成没有 title 的那条
  });
});

/* ==================================================================================
 * 第五轮必修 M-D：闭合侧补分隔必须【标点感知】
 * 判据（复核给出、碧霄采纳）：词边界多插（`word<b>bold</b>` → "word bold"）可以接受
 * （宁可多切不可粘连，且不改词序）；但紧邻标点时多插不可接受 —— 它把标点从词上剥下来
 * 变成独立 token（"term ."），直接伤害短语匹配与中文分词。
 * ================================================================================== */

describe("M-D 闭合侧分隔符标点感知：标点不再被剥成独立 token（第四轮引入的回退）", () => {
  const struct = (inner: string) =>
    parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>e</id>' +
        '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">' +
        inner +
        "</div></content></entry></feed>",
    ).entries[0].content;

  const cases: Array<[string, string]> = [
    ["<em>term</em>.", "term."], // 实测第四轮给 "term ."
    ["<span>1</span>,<span>2</span>", "1, 2"], // 实测第四轮给 "1 , 2"
    ["见<b>粗体</b>，后文", "见 粗体，后文"], // 实测第四轮给 "见 粗体 ，后文"
    ['<a href="u">L</a>, x', "L, x"], // 实测第四轮给 "L , x"
    ["<p>句子。</p><p>后一句</p>", "句子。 后一句"], // 句号后接元素：该插的仍插
    ["<b>粗</b>、<b>黑</b>", "粗、 黑"], // 顿号紧邻不插，元素边界处照插
    ['<a href="u">链接</a>（注）', "链接（注）"], // 全角括号也属标点，不拆
    ["<em>x</em>?yes", "x?yes"],
  ];
  for (const [body, want] of cases) {
    it(`标记剥离路径：${body} ⇒ ${JSON.stringify(want)}`, () => {
      expect(contentOf(body)).toBe(want);
    });
    it(`XML 结构路径同口径：${body} ⇒ ${JSON.stringify(want)}`, () => {
      expect(struct(body)).toBe(want);
    });
  }

  it("关键反例不许改坏：源里本来就有空格的 `Hello world !` 保持原样（不是 Hello world!）", () => {
    expect(contentOf("Hello <b>world</b> !")).toBe("Hello world !");
    expect(struct("Hello <b>world</b> !")).toBe("Hello world !");
  });

  it("词边界多插仍然可接受（宁多切不可粘连）：word<b>bold</b> → 'word bold'", () => {
    expect(contentOf("word<b>bold</b>")).toBe("word bold");
    expect(struct("word<b>bold</b>")).toBe("word bold");
    expect(contentOf("A<b>B</b>C")).toBe("A B C");
    expect(contentOf("A<br/>B")).toBe("A B");
  });

  it("空白侧同样不重复补：元素边界两侧都已有空白时不造出双空格", () => {
    for (const probe of [
      "<em>term</em>.",
      "<span>1</span>,<span>2</span>",
      "见<b>粗体</b>，后文",
      'Hello <b>world</b> !',
      "A<b>B</b>C",
      "<p>Alpha </p><p> Beta</p>",
    ]) {
      expect(/  /.test(contentOf(probe)), `无双空格：${probe}`).toBe(false);
      expect(/  /.test(struct(probe)), `无双空格：${probe}`).toBe(false);
    }
  });

  it("两条路径（XML 结构 / CDATA 标记剥离）对本轮全部标点形态给出同一个结果", () => {
    for (const [body] of cases) expect(struct(body), body).toBe(contentOf(body));
  });

  it("三固件计数与残留口径不因本轮分隔规则改动（20 / 75 / 25 + 出口零残留）", () => {
    expect(parseFeed(hnRss2).entries).toHaveLength(20);
    expect(parseFeed(natureRdf).entries).toHaveLength(75);
    expect(parseFeed(redditAtom).entries).toHaveLength(25);
    for (const feed of [parseFeed(hnRss2), parseFeed(natureRdf), parseFeed(redditAtom)]) {
      for (const entry of feed.entries) {
        for (const value of [entry.title, entry.content, entry.summary, entry.id, entry.link]) {
          expectNoMarkup(value, "真实固件出口");
        }
      }
    }
  });
});

/* ==================================================================================
 * 第五轮必修 M-F / M-G / item5：尺子的三条新判据
 *  M-F 布尔属性：至多 1 个裸属性名 ⇒ 仍是标记（推翻"语法上无法区分"的 over-claim）
 *  M-G 标记名首字符不得为数字（+ 泛型/比较形态的散文守卫）
 *  item5 长标记（data URI / 超长属性值）的标签体不得泄漏进 content
 * ================================================================================== */

describe("M-F 布尔属性：至多 1 个裸属性名时判为标记", () => {
  it("复核 p2 的四个真实老式 HTML 样本：全部剥净", () => {
    expect(contentOf("<input readonly>tail")).toBe("tail");
    expect(contentOf('<td nowrap bgcolor="red">A</td>')).toBe("A");
    expect(contentOf("<button disabled>x</button>")).toBe("x");
    expect(contentOf("<hr noshade size=1>tail")).toBe("tail");
  });

  it("尺子单元：1 个裸属性名 = 标记；2 个及以上 = 散文", () => {
    expect(isWellFormedMarkupAt("<input readonly>", 0)).toBe(16);
    expect(isWellFormedMarkupAt('<td nowrap bgcolor="red">', 0)).toBe(25);
    expect(isWellFormedMarkupAt("<a href=x y>", 0)).toBe(12); // 1 裸名
    expect(isWellFormedMarkupAt("<a href=x y z>", 0)).toBe(-1); // 2 裸名
    expect(isWellFormedMarkupAt("<b and c>", 0)).toBe(-1); // 2 裸名
  });

  it("散文仍必须保住（>1 裸属性时与散文确实无法区分，这才是本轮规则的准确表述）", () => {
    expect(contentOf("if (a<b and c>d) return true")).toBe("if (a<b and c>d) return true");
    expect(contentOf("参数 a<max 且 b>min 时成立")).toBe("参数 a<max 且 b>min 时成立");
    expect(contentOf("x <a href=x y z>y")).toBe("x <a href=x y z>y");
    expect(findMarkupStart(contentOf("x <a href=x y z>y"))).toBe(-1);
  });

  it("已知代价①（显式用例）：恰好 1 个裸词的散文会被吞（`a<b c>d` 这类写法罕见，两害相权）", () => {
    expect(contentOf("a<b c>d")).toBe("a d");
  });

  it("已知代价②（显式用例）：多于 1 个裸属性的老式【开】标签仍留字面（闭合标签照剥 = 不对称行为，如实钉住）", () => {
    const out = contentOf("<video autoplay muted loop controls>x</video>");
    // 开标签有 4 个裸属性名 → 判散文留下；</video> 语法合法 → 仍被剥掉
    expect(out).toBe("<video autoplay muted loop controls>x");
    expect(findMarkupStart(out)).toBe(-1); // 实现尺认它是散文（宽尺会认，见豁免清单）
  });

  it("真实老式 HTML 片段：残留标记段 6 → 1（复核 p2 实测口径）", () => {
    const legacy =
      "<table border=1 cellpadding=0><tr><td nowrap bgcolor=#fff><b>老站</b></td>" +
      "<td><input type=text readonly value=x><br><hr noshade size=1></td></tr>" +
      "<tr><td colspan=2 align=center><font size=4 color=red>公告</font></td></tr></table>";
    const out = contentOf(legacy);
    expect(out).toContain("老站");
    expect(out).toContain("公告");
    expect(out).not.toContain("noshade");
    expect(out).not.toContain("bgcolor");
    expect(out).not.toContain("readonly");
    expect(out).not.toContain("<td");
    expect(out).not.toContain("<hr");
    expect(out).not.toContain("<br");
  });
});

describe("M-G 标记名首字符不得为数字 + 泛型/比较形态的散文守卫", () => {
  it("复核四例：数学比较与泛型必须原样保住", () => {
    expect(contentOf("当 1<2>0 时成立")).toBe("当 1<2>0 时成立");
    expect(contentOf("std::vector<int> v;")).toBe("std::vector<int> v;");
    expect(contentOf("List<T> list = new ArrayList<T>();")).toBe("List<T> list = new ArrayList<T>();");
    expect(contentOf("变量 a<b>c 时")).toBe("变量 a<b>c 时");
  });

  it("尺子单元：数字不是合法名字首字符；`_` 与 `#` 开头仍是标记", () => {
    expect(isWellFormedMarkupAt("<1abc>", 0)).toBe(-1);
    expect(isWellFormedMarkupAt("</1abc>", 0)).toBe(-1);
    expect(isWellFormedMarkupAt("<_x>", 0)).toBe(4);
    expect(isWellFormedMarkupAt("<#if a==b#>", 0)).toBe(11);
    expect(isWellFormedMarkupAt("<div>", 0)).toBe(5);
  });

  it("`<_x>` / `<#if a==b#>` 这类伪标签仍必须与真标记一样剥净（首字符规则只挡住数字）", () => {
    expect(contentOf("<_x>secret</_x>")).toBe("secret");
    expect(contentOf("<#if a==b#>tail")).toBe("tail");
  });

  it("【行为变化登记】数字开头伪标签现在留字面（有意取舍，写清楚为什么换）", () => {
    // 数字开头的标签在 XML/HTML 里本就非法、现实 feed 不会出现；
    // 而 1<2>0 / vector<int> / List<T> 是代码类与技术类 feed 的常态内容 ⇒ 两害相权取其轻。
    expect(contentOf("<1abc>secret</1abc>")).toBe("<1abc>secret</1abc>");
    expect(
      parseFeed(
        '<rss version="2.0"><channel><title>T</title><item>' +
          "<guid>id&amp;lt;1abc&amp;gt;x&amp;lt;/1abc&amp;gt;</guid></item></channel></rss>",
      ).entries[0].id,
    ).toBe("id<1abc>x</1abc>");
  });

  it("泛型守卫的边界：有闭合证据 / 自闭合 / void 名单 / 带属性 ⇒ 照样剥（守卫不放过真标记）", () => {
    expect(contentOf("word<b>bold</b>")).toBe("word bold"); // 有闭合标签
    expect(contentOf('x<img src="a.png">y')).toBe("x y"); // 带属性
    expect(contentOf("x<br>y")).toBe("x y"); // void 名单内
    expect(contentOf('a<span class="s">b</span>')).toBe("a b"); // 带属性 + 有闭合
    expect(contentOf("<1abc>secret</1abc>")).toBe("<1abc>secret</1abc>"); // 数字开头 → 散文
  });

  it("守卫没把真标记放成散文：三个真实固件出口仍然零残留", () => {
    for (const feed of [parseFeed(hnRss2), parseFeed(natureRdf), parseFeed(redditAtom)]) {
      for (const entry of feed.entries) {
        expectNoMarkup(entry.content, "真实固件 content");
        expectNoMarkup(entry.title, "真实固件 title");
        expectNoMarkup(entry.summary, "真实固件 summary");
      }
    }
  });
});

describe("item5 长标记（data URI / 超长属性值）的标签体不得进入 content", () => {
  it("5000 字 base64 的 <img src=\"data:...\">：标签体整体剥掉，正文里没有 base64 / data:", () => {
    const b64 = "QkVG".repeat(1250); // 5000 字符
    const content = contentOf(`<p>前文</p><img src="data:image/png;base64,${b64}"><p>后文</p>`);
    expect(content).toBe("前文 后文");
    expect(content).not.toContain("base64");
    expect(content).not.toContain("data:");
    expect(content).not.toContain("QkVG");
    expect(content.length).toBeLessThan(64);
    expectNoMarkup(content, "长 img 标签结果");
  });

  it("跨度 4097 的真标记（超 MAX_MARKUP_SPAN）必须被剥（旧尺子把它当散文留下 = 泄漏 4090 字属性值）", () => {
    const value = "x".repeat(4090);
    const markup = `<a href="${value}">`;
    expect(markup.length).toBeGreaterThan(MAX_MARKUP_SPAN); // 确实超过旧上限
    const content = contentOf(`链接：${markup}目标</a>`);
    expect(content).toBe("链接： 目标");
    expect(content).not.toContain(value);
    expectNoMarkup(content, "4097 跨度标记结果");
  });

  it("尺子单元：长标记被认下（不受 4096 限制），绝对上限之外仍是散文", () => {
    expect(isWellFormedMarkupAt(`<a href="${"y".repeat(5000)}">`, 0)).toBe(5011);
    const absurd = `<a href="${"y".repeat(MAX_MARKUP_ABSOLUTE_SPAN + 10)}">`;
    expect(isWellFormedMarkupAt(absurd, 0)).toBe(-1);
  });

  it("散文必须仍然保住（不许退回『见 < 就吞』）", () => {
    expect(contentOf("if (a<b and c>d) return true")).toBe("if (a<b and c>d) return true");
    expect(contentOf("参数 a<max 且 b>min 时成立")).toBe("参数 a<max 且 b>min 时成立");
    expect(contentOf("x <a href=x y z>y")).toBe("x <a href=x y z>y");
    // 超长"名字"（不是超长属性值）依旧按散文保留：这正是 50KB 正文不被吞的同一条判据
    expect(contentOf("HEAD<b" + "x".repeat(50000) + ">TAIL").length).toBeGreaterThan(40000);
  });

  it("病态长输入线性：超长标记 + 无闭合引号 + 大量孤立 '<' 的约 2MiB 串必须快速返回", () => {
    const body = '<img src="data:image/png;base64,' + "A".repeat(600 * 1024) + '">';
    const pathological = body.repeat(3) + '<a href="unclosed' + "<a".repeat(200000);
    const start = Date.now();
    const content = contentOf(pathological);
    const elapsed = Date.now() - start;
    expect(content).not.toContain("data:");
    expect(elapsed, `耗时 ${elapsed}ms（线性预算）`).toBeLessThan(20_000);
  }, 60_000);
});

/* ==================================================================================
 * 第五轮·测试层结构性补强：关掉"一把尺子"的自指盲区
 * ----------------------------------------------------------------------------------
 * expectNoMarkup() 用的是实现导出的 findMarkupStart —— 好处是口径永不与实现自相矛盾，
 * 代价是【实现说"这不是标记"，断言就永远不判红】（上一轮变异体检实证：改坏标签形态
 * 判定后，实现尺跟着放行，全绿）。本轮补第二把尺子：
 *   · 它【故意比实现宽】：只认形态 `</?ASCII字母 [名字字符]* 后接空白、/、> 或串尾`，
 *     不问属性语法是否合法、不管跨度上限、不看首字符规则之外的一切例外。
 *   · 它的唯一职责是【发现新残留】：已登记豁免之外必须零命中。
 *   · 豁免清单是【显式、逐条、可数的】：实现放松 → 命中数变化 → 必红；要让它继续绿，
 *     唯一办法是把新例外登记进来 —— 那是一次有记录的口径变更，而不是静默放行。
 * ================================================================================== */

/** 故意更宽的独立尺（测试自带，绝不引用实现导出的谓词；lookahead 不消耗字符） */
const WIDE_MARKUP_SHAPE = /<\/?[A-Za-z][A-Za-z0-9_.:\-]*(?=[\s/>]|$)/gi;

/** 宽尺命中列表（token 截断到 24 字符，便于断言与阅读；长名字只关心"有没有命中"） */
function wideMarkupSpans(text: string): string[] {
  const hits: string[] = [];
  WIDE_MARKUP_SHAPE.lastIndex = 0; // 全局正则的 lastIndex 是共享状态，每次调用必须先归零
  let m: RegExpExecArray | null;
  while ((m = WIDE_MARKUP_SHAPE.exec(text)) !== null) hits.push(m[0].slice(0, 24));
  return hits;
}

/** 宽尺零残留断言：任何未登记的标签形态残留都判红，并把上下文打出来 */
function expectNoWideMarkup(text: string, where = "文本"): void {
  expect(wideMarkupSpans(text), `${where} 宽尺发现残留：${JSON.stringify(text.slice(0, 100))}`).toEqual([]);
}

describe("独立宽尺（比实现更宽的第二把尺子）：尺子自身的口径先钉死", () => {
  it("宽尺认得实现【可能放行】的形态（这是它存在的意义）", () => {
    expect(wideMarkupSpans("x <a href=x y z>y")).toEqual(["<a"]); // 实现的 M-F 例外
    expect(wideMarkupSpans("<div>x</div>")).toEqual(["<div", "</div"]);
    expect(wideMarkupSpans("<br/>")).toEqual(["<br"]); // lookahead 不消耗 '/'
    expect(wideMarkupSpans("<my-widget>")).toEqual(["<my-widget"]);
    expect(wideMarkupSpans("text <div")).toEqual(["<div"]); // 串尾形态也要抓到
    expect(wideMarkupSpans("a<b>c")).toEqual(["<b"]);
    expect(wideMarkupSpans("std::vector<int> v;")).toEqual(["<int"]); // 泛型：宽尺认它
    expect(wideMarkupSpans("List<T>")).toEqual(["<T"]);
    expect(wideMarkupSpans("参数 a<max 且 b>min")).toEqual(["<max"]);
  });

  it("宽尺【不认】的形态同样钉住（否则豁免清单会凭空多出/少掉命中）", () => {
    expect(wideMarkupSpans("<1abc>secret</1abc>")).toEqual([]); // 数字开头：名字首字符不是字母
    expect(wideMarkupSpans("<2>x")).toEqual([]);
    expect(wideMarkupSpans("<_x>secret</_x>")).toEqual([]); // `_` 开头
    expect(wideMarkupSpans("<#if a==b#>tail")).toEqual([]); // `#` 开头
    expect(wideMarkupSpans("当 1<2>0 时成立")).toEqual([]); // `<` 后是数字
    expect(wideMarkupSpans("if (a < b) x")).toEqual([]); // `<` 后是空格
    expect(wideMarkupSpans("<且 b>x")).toEqual([]); // 非 ASCII 名字（中文正文不许被误报）
    expect(wideMarkupSpans("<!-- c -->x")).toEqual([]); // 注释形态由下面的字面检查负责
  });

  it("三个真实固件：宽尺与实现尺【两把都】零残留（20 / 75 / 25 计数不变）", () => {
    const corpus: Array<[string, ReturnType<typeof parseFeed>, number]> = [
      ["hn-rss2", parseFeed(hnRss2), 20],
      ["nature-rdf", parseFeed(natureRdf), 75],
      ["reddit-atom", parseFeed(redditAtom), 25],
    ];
    for (const [name, feed, want] of corpus) {
      expect(feed.entries).toHaveLength(want);
      for (const entry of feed.entries) {
        const fields: Array<[string, string]> = [
          ["content", entry.content],
          ["summary", entry.summary],
          ["title", entry.title],
          ["id", entry.id],
          ["link", entry.link],
        ];
        for (const [field, value] of fields) {
          expectNoMarkup(value, `${name} ${field}（实现尺）`);
          expectNoWideMarkup(value, `${name} ${field}（宽尺）`);
        }
      }
    }
  });

  it("豁免清单：已披露例外逐条可数，命中集合完全等于登记值（新增例外必须写进这里）", () => {
    const disclosed: Array<[string, string[]]> = [
      ["x <a href=x y z>y", ["<a"]], // M-F：>1 裸属性 ⇒ 与散文无法区分（第四轮定、第五轮沿用）
      ["if (a<b and c>d) return true", ["<b"]], // N5：多个裸词 ⇒ 散文
      ["参数 a<max 且 b>min 时成立", ["<max"]], // N5：非 ASCII 不进名字
      ["<video autoplay muted loop controls>x", ["<video"]], // M-F 代价②：>1 裸属性留字面
      ["变量 a<b>c 时", ["<b"]], // M-G 守卫：紧贴词 + 无闭合证据 ⇒ 有意保留的散文
      ["std::vector<int> v;", ["<int"]], // M-G 守卫：泛型参数 ⇒ 有意保留
      ["List<T> list = new ArrayList<T>();", ["<T", "<T"]], // M-G 守卫：两个泛型实参
      ["当 1<2>0 时成立", []], // M-G 首字符规则：数字开头，宽尺也不认
      ["<1abc>secret</1abc>", []], // M-G 登记：数字开头 ⇒ 留字面但不算标签形态
    ];
    for (const [body, expected] of disclosed) {
      expect(wideMarkupSpans(contentOf(body)), `豁免清单条目：${body}`).toEqual(expected);
    }
    // 泛型守卫一旦失效（标签被吞），下面两条断言先红 ⇒ 豁免清单不会被"顺手改宽"
    expect(contentOf("std::vector<int> v;")).toBe("std::vector<int> v;");
    expect(contentOf("List<T> list = new ArrayList<T>();")).toBe("List<T> list = new ArrayList<T>();");
  });

  it("非例外集合：宽尺与实现尺都必须零命中（本轮修好的形态一律不许留残留）", () => {
    const clean: string[] = [
      "<input readonly>tail",
      '<td nowrap bgcolor="red">A</td>',
      "<button disabled>x</button>",
      "<hr noshade size=1>tail",
      "<_x>secret</_x>",
      "<#if a==b#>tail",
      "<b>bold</b>",
      "word<b>bold</b>",
      '<a href="u">L</a>, x',
      "<em>term</em>.",
      "见<b>粗体</b>，后文",
      '<img src="data:image/png;base64,' + "Q".repeat(5000) + '">后文',
      `<a href="${"z".repeat(4090)}">目标</a>`,
      "<my-widget>x</my-widget>",
      "HEAD<b" + "x".repeat(50000) + ">TAIL",
    ];
    for (const body of clean) {
      const out = contentOf(body);
      expectNoMarkup(out, `实现尺零残留：${body.slice(0, 40)}`);
      // 超长名字那例是【有意的散文保留】：宽尺会认它，所以单独登记命中数
      if (body.startsWith("HEAD<b" + "x".repeat(50000))) {
        expect(wideMarkupSpans(out).length, "超长名字保留 = 1 处已披露宽尺命中").toBe(1);
      } else {
        expectNoWideMarkup(out, `宽尺零命中：${body.slice(0, 40)}`);
      }
    }
  });

  it("注释/声明/PI：宽尺不认这些形态，用字面检查补上（否则这三类没有第二把尺兜底）", () => {
    expect(contentOf("<!-- 秘密注释 -->keep")).toBe("keep");
    expect(contentOf("<!DOCTYPE html>keep")).toBe("keep");
    expect(contentOf("<?xml?>keep")).toBe("keep");
    for (const body of ["<!-- c -->keep", "<!DOCTYPE html>keep", "<?xml?>keep", "<![CDATA[x]]>keep"]) {
      const out = contentOf(body);
      expect(out, `字面检查：${body}`).not.toMatch(/<!--|<!\[|<!DOC|<\?/);
    }
  });
});

/* ==================================================================================
 * 第五轮·反自指钉桩：上一轮变异体检里"改坏实现却依然全绿"的角度，逐个补独立钉
 *（X4 常数取值 / X10 预算边界 / X12 时间权重 / X13 同分 tie-break / X22 连字符名字）
 * 这些钉子全部用【字面量】写，绝不写 f(常数) —— 常数被改就必须变红。
 * ================================================================================== */

describe("反自指钉桩：常数取值与判定边界用字面量钉", () => {
  it("尺子常数与预算常数的取值就是当下口径（改数值 ⇒ 必红）", () => {
    expect(MAX_MARKUP_SPAN).toBe(4096);
    expect(MAX_MARKUP_NAME_LEN).toBe(256);
    expect(MAX_MARKUP_ABSOLUTE_SPAN).toBe(1048576);
    expect(MAX_FEED_INPUT_BYTES).toBe(8388608);
    expect(MAX_FEED_INPUT_CHARS).toBe(8388608);
  });

  it("名字上限 256：256 字符名字是标记、257 字符名字按散文保留（不靠 repeat(常数)）", () => {
    const at256 = "<" + "n".repeat(256) + ">";
    const at257 = "<" + "n".repeat(257) + ">";
    expect(at256.length).toBe(258);
    expect(isWellFormedMarkupAt(at256 + "body", 0)).toBe(258);
    expect(isWellFormedMarkupAt(at257 + "body", 0)).toBe(-1);
    expect(contentOf(at256 + "body")).toBe("body");
    expect(contentOf(at257 + "body").startsWith(at257 + "body")).toBe(true);
  });

  it("绝对跨度上限 1MiB：万把字的属性值仍当标记（不受 4096 限制），越界不吞", () => {
    const tag3000 = `<a href="${"v".repeat(3000)}">`;
    expect(isWellFormedMarkupAt(tag3000 + "X</a>", 0)).toBe(tag3000.length);
    const tag10000 = `<a href="${"v".repeat(10000)}">`;
    expect(tag10000.length).toBeGreaterThan(MAX_MARKUP_SPAN); // 远超旧的 4096 单界
    expect(isWellFormedMarkupAt(tag10000 + "X</a>", 0)).toBe(tag10000.length);
    expect(contentOf(tag10000 + "X</a>")).toBe("X");
    const over = `<a href="${"v".repeat(1048576)}">`;
    expect(isWellFormedMarkupAt(over, 0)).toBe(-1); // 恰好吃满绝对窗口 ⇒ 判散文（保守留下）
  });

  it("注释/声明仍受 4096 约束（本轮没有放宽这一类：它们吞掉的是【体】）", () => {
    const inside = "<!--" + "u".repeat(4089) + "-->"; // 总跨度恰好 4096
    expect(inside.length).toBe(4096);
    expect(isWellFormedMarkupAt(inside, 0)).toBe(4096);
    const outside = "<!--" + "u".repeat(4090) + "-->"; // 4097 ⇒ 越界
    expect(outside.length).toBe(4097);
    expect(isWellFormedMarkupAt(outside, 0)).toBe(-1);
    const decl = "<!" + "d".repeat(4093) + ">"; // 2 + 4093 + 1 = 4096 ⇒ 恰好在界内
    expect(decl.length).toBe(4096);
    expect(isWellFormedMarkupAt(decl, 0)).toBe(4096);
    expect(isWellFormedMarkupAt("<!" + "d".repeat(4094) + ">", 0)).toBe(-1);
  });

  it("预算判断用【>】不用【>=】：恰好 8388608 字节必须放行，+1 必须拒（X10 的独立钉）", () => {
    const head = '<rss version="2.0"><channel><title>T</title><item><guid>exact-max</guid><description>';
    const tail = "</description></item></channel></rss>";
    const exact = head + "p".repeat(8388608 - head.length - tail.length) + tail;
    expect(utf8ByteLength(exact)).toBe(8388608);
    const parsed = parseFeed(exact); // 【>=】写法会在这里把恰好合规的输入误杀
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].content.length).toBe(8388608 - head.length - tail.length);
    expect(() => parseFeed(exact + "p")).toThrowError(FeedInputTooLargeError);
  }, 120_000);

  it("规范化复检的边界同样是【>】：放大后恰好 8388608 字节放行，+1 拒（M-A 的边界独立钉）", () => {
    const head = '<rss version="2.0"><channel><title>T</title><item><guid>exact-norm</guid><description>';
    const tail = "</description></item></channel></rss>";
    const budget = 8388608 - head.length - tail.length; // 每个裸 & 规范化后占 5 字节（&amp;）
    const amps = Math.floor(budget / 5);
    const pad = budget % 5;
    const xml = head + "&".repeat(amps) + "q".repeat(pad) + tail;
    expect(utf8ByteLength(xml)).toBeLessThan(8388608); // 原始输入在上限内（前置校验放过）
    expect(amps * 5 + pad).toBe(budget);
    expect(head.length + amps * 5 + pad + tail.length).toBe(8388608); // 规范化后恰好顶到上限
    expect(() => parseFeed(xml)).not.toThrowError(FeedInputTooLargeError);
    // 上一轮用例给余量太宽，改一点没感觉；这里 +1 字节必须精确判红
    const over = head + "&".repeat(amps) + "q".repeat(pad + 1) + tail;
    expect(head.length + amps * 5 + pad + 1 + tail.length).toBe(8388609);
    expect(() => parseFeed(over)).toThrowError(FeedInputTooLargeError);
  }, 120_000);

  it("完整度权重：五个出口【各算 1】、时间恰好 1 个单位、覆盖优先于体量（X12 的独立钉）", () => {
    const g = (n: string, inner: string) => `<item><guid>${n}</guid>${inner}</item>`;
    const pair = (first: string, second: string) =>
      parseFeed(`<rss><channel><title>C</title>${first}${second}</channel></rss>`).entries;
    const D100 = "d".repeat(100);
    const D200 = "d".repeat(200);

    // 先钉住映射事实（后面每条判据都建立在它上面）：
    // description / content:encoded 都会【同时】填 summary 与 content ⇒ 文本体一次贡献 2 个出口、2 倍体量
    const body2 = pair(g("M0", `<content:encoded>${D100}</content:encoded>`), g("M0", ""))[0];
    expect(body2.summary).toBe(D100);
    expect(body2.content).toBe(D100);

    // ① title 计入（1 个单位）：甲 = title + 100字文本体（覆盖 3、体量 200），
    //    乙 = 200字文本体（覆盖 2、体量 400）。title 不算 ⇒ 覆盖 2 打平 ⇒ 体量 400 翻盘 ⇒ summary 变 D200。
    expect(pair(g("K1", `<title>甲</title><description>${D100}</description>`), g("K1", `<description>${D200}</description>`))[0].summary).toBe(D100);

    // ② link 计入：乙 = title + link + 文本体（覆盖 4）vs 甲 = title + 文本体（覆盖 3、体量 200）。
    //    link 不算 ⇒ 覆盖 3 打平 ⇒ 甲体量 200 胜 ⇒ title 变"甲"。
    expect(pair(g("K2", `<title>甲</title><description>${D100}</description>`), g("K2", `<title>乙</title><link>L</link><content:encoded>c</content:encoded>`))[0].title).toBe("乙");

    // ③ publishedAt 至少算 1 个单位：乙 = title + pubDate + 文本体（覆盖 4）vs 甲（覆盖 3、体量 200）。
    //    时间不算 ⇒ 覆盖 3 打平 ⇒ 甲体量胜 ⇒ title 变"甲"。
    expect(pair(g("K3", `<title>甲</title><description>${D100}</description>`), g("K3", `<title>乙</title><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate><content:encoded>c</content:encoded>`))[0].title).toBe("乙");

    // ④ publishedAt 至多算 1 个单位（不给额外加权）：甲 = title + link（覆盖 2、体量 0），
    //    乙 = title + pubDate（覆盖 2、体量 0）⇒ 完全平手 ⇒ 取先出现 ⇒ 甲。
    //    时间被算成 2 个单位 ⇒ 乙覆盖 3 ⇒ title 变"乙"。与 ③ 合起来把"恰好 1"夹死。
    expect(pair(g("K4", "<title>甲</title><link>L</link>"), g("K4", "<title>乙</title><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate>"))[0].title).toBe("甲");

    // ⑤ 非出口字段（author / category）不计入：乙带它们也只算覆盖 3 ⇒ 与甲打平 ⇒ 甲体量 200 胜。
    //    只要把它们算进覆盖 ⇒ 乙胜出 ⇒ title 变"乙"。
    expect(pair(g("K5", `<title>甲</title><description>${D100}</description>`), g("K5", "<title>乙</title><author>x</author><category>y</category><content:encoded>c</content:encoded>"))[0].title).toBe("甲");

    // ⑥ 体量只数 content+summary 的字符数（title / link 的长度不参与）：甲 = title + pubDate（覆盖 2、体量 0），
    //    乙 = title + 500字 link（覆盖 2、体量 0）⇒ 平手取先出现 ⇒ 甲。
    //    体量把 link/title 长度也算进去 ⇒ 乙体量 501 ⇒ title 变"乙"。
    expect(pair(g("K6", "<title>甲</title><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate>"), g("K6", `<title>乙</title><link>${"L".repeat(500)}</link>`))[0].title).toBe("甲");

    // ⑦ 两层判据的【顺序】：覆盖优先于体量。甲 = title + 500字文本体（覆盖 3、体量 1000），
    //    乙 = title + 1字文本体 + link（覆盖 4、体量 2）⇒ 乙按覆盖胜。
    //    先比体量 ⇒ 甲 1000 胜 ⇒ title 变"甲"。
    expect(pair(g("K7", `<title>甲</title><description>${"v".repeat(500)}</description>`), g("K7", `<title>乙</title><description>c</description><link>L</link>`))[0].title).toBe("乙");

    // ⑧ 文本体一次贡献 2 个出口（summary 与 content 同时被填），所以甲的体量 400 压不过乙的覆盖 3：
    //    甲 = 200字文本体（覆盖 2、体量 400），乙 = title + 1字文本体（覆盖 3、体量 2）⇒ 乙为底。
    expect(pair(g("K8", `<description>${"w".repeat(200)}</description>`), g("K8", `<title>乙</title><description>c</description>`))[0].title).toBe("乙");

    // ⑨ 平手取先出现（权重相等的两个出口之间不分高下）
    expect(pair(g("W1", "<title>先</title>"), g("W1", "<link>L</link>"))[0].title).toBe("先");
    // ⑩ 并集：落选者唯一的出口必须补进底里（title 甲保住、summary 乙也保住）
    const w4 = pair(g("W4", "<title>甲</title>"), g("W4", '<description>乙</description>'));
    expect(w4[0].title).toBe("甲");
    expect(w4[0].summary).toBe("乙");
    // ⑪ 五出口全满 vs 覆盖 3 ⇒ 全满者为底
    const full = pair(
      g("W6", "<title>甲</title><pubDate>Mon, 01 Sep 2025 08:00:00 +0000</pubDate>"),
      g("W6", "<title>乙</title><link>L</link><content:encoded>body</content:encoded><description>sum</description>"),
    );
    expect(full[0].title).toBe("乙");
    expect(full[0].content).toBe("body");
    expect(full[0].link).toBe("L");
    expect(full[0].summary).toBe("sum");
  });

  it("体量作第二判据：覆盖相同才比 content+summary 字符数（X12 的第二层）", () => {
    const long = "L".repeat(200);
    const entries = parseFeed(
      "<rss><channel><title>C</title>" +
        "<item><guid>V</guid><title>短</title><description>tiny</description></item>" +
        `<item><guid>V</guid><title>长</title><description>${long}</description></item>` +
        "</channel></rss>",
    ).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("长"); // 不比体量 ⇒ 平手取先出现 ⇒ "短"
    expect(entries[0].content).toBe(long);
    expect(entries[0].summary).toBe(long);
  });

  it("同分 tie-break：完全同分取先出现者，且【逐字段各挑】必须被钉死（X13 的独立钉）", () => {
    const two = parseFeed(
      "<rss><channel><title>C</title>" +
        "<item><guid>T</guid><title>第一</title><link>l1</link><description>d1</description></item>" +
        "<item><guid>T</guid><title>第二</title><link>l2</link><description>d2</description></item>" +
        "</channel></rss>",
    ).entries;
    expect(two).toHaveLength(1);
    expect(two[0]).toEqual({ id: "T", title: "第一", link: "l1", summary: "d1", content: "d1" });
    const three = parseFeed(
      "<rss><channel><title>C</title>" +
        "<item><guid>T3</guid><title>一</title></item>" +
        "<item><guid>T3</guid><title>二</title></item>" +
        "<item><guid>T3</guid><title>三</title></item>" +
        "</channel></rss>",
    ).entries;
    expect(three[0].title).toBe("一");
  });

  it("名字字符集里的 `-` 与 `.`（X22 的独立钉）：`<my-widget>` 必须剥净", () => {
    expect(isWellFormedMarkupAt("<my-widget>", 0)).toBe(11);
    expect(contentOf("<my-widget>x</my-widget>")).toBe("x");
    expect(contentOf("<x.y>x</x.y>")).toBe("x");
    expectNoWideMarkup(contentOf("<my-widget>x</my-widget>"), "自定义元素");
    // `-` / `.` 只能出现在名字中间：作首字符不是合法标记名 ⇒ 保守留字面
    expect(isWellFormedMarkupAt("<-b>", 0)).toBe(-1);
    expect(isWellFormedMarkupAt("<.x>", 0)).toBe(-1);
  });

  it("粘合判据（M-D 的取值钉）：标点/符号都算粘合，字母/数字/汉字不算", () => {
    const glued: Array<[string, string]> = [
      ["<b>term</b>.", "term."],
      ["<b>term</b>,next", "term,next"],
      ["<b>term</b>;next", "term;next"],
      ["<b>term</b>:next", "term:next"],
      ["<b>term</b>!next", "term!next"],
      ["<b>term</b>?next", "term?next"],
      ["<b>term</b>(next)", "term(next)"],
      ['<b>term</b>"q"', 'term"q"'],
      ["<b>term</b>'q'", "term'q'"],
      ["<b>term</b>-next", "term-next"],
      ["<b>term</b>/next", "term/next"],
      ["<b>term</b>+1", "term+1"],
      ["<b>term</b>=1", "term=1"],
      ["<b>价</b>￥100", "价￥100"],
      ["<b>term</b>。后", "term。后"],
      ["<b>term</b>】后", "term】后"],
      ["<b>term</b>～后", "term～后"],
      ["<b>term</b>—后", "term—后"],
    ];
    for (const [body, want] of glued) expect(contentOf(body), body).toBe(want);
    const split: Array<[string, string]> = [
      ["<b>term</b>word", "term word"],
      ["<b>term</b>9", "term 9"],
      ["<b>term</b>词", "term 词"],
      ["<b>a</b><b>b</b>", "a b"],
    ];
    for (const [body, want] of split) expect(contentOf(body), body).toBe(want);
    // 空白开头同样不重复补（判据里的 \s 分支；删掉它会造出双空格，而 \s+ 归一只在散文出口）
    for (const body of ["<b>a</b> b", "<b>a</b>\nb", "<b>a</b>\t\tb"]) {
      expect(/  /.test(contentOf(body)), `空白后不重复补：${body}`).toBe(false);
    }
  });
});

/* ==================================================================================
 * 第六轮（冻结前收口轮）·t1 r6 —— 复核给出的 6 条最小清单，逐条上护栏
 * ----------------------------------------------------------------------------------
 * 这一节的存在理由：上一轮之前这些角度全是【改坏实现却依然全绿】的盲区
 *  · R1（第 1 条）字面 '<' 旁路绕过 emit() ⇒ 正文被插入源中不存在的空格 + 两路径分裂
 *  · Y12（第 2 条）全串无 '>' 的快退护栏零断言（删掉它 212 全绿，0.17MiB 输入实测 39.4s）
 *  · Y17（第 3 条）CLOSE_TAG_NAME 的 i 标志零断言（删掉它 212 全绿，大写 HTML 真退化）
 *  · item4（第 4 条）标识符出口吃泛型守卫 ⇒ 源站加/删一个 </div> 就能换主键
 *  · item5（第 5 条）死条件 !closing（实现侧删除，由全量绿 + 变异体检验收）
 *  · item6（第 6 条）两个可判别错误的【文案】零断言（事故重建前后措辞已漂移过）+ 三处申报
 * ================================================================================== */

describe("r6-item1 R1 字面 '<' 必须走 emit：边界不许被推到 '<' 之后（静默插空格 + 两路径分裂）", () => {
  /** Atom content type="xhtml" 的结构路径（与 contentOf 的 CDATA 标记剥离路径互为对照） */
  const structPath = (inner: string) =>
    parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>e</id>' +
        '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">' +
        inner +
        "</div></content></entry></feed>",
    ).entries[0].content;

  // [CDATA 里的字面形态, 结构路径里【等价】的 XML 形态（同一段字面 '<'，XML 里必须转义）, 两条路径共同的期望结果]
  const forms: Array<[string, string, string]> = [
    ["A<em>x</em><3>B", "A<em>x</em>&lt;3&gt;B", "A x<3>B"],
    ["x<br/><b c d>y", "x<br/>&lt;b c d&gt;y", "x<b c d>y"],
    ["a<i>b</i><3>c", "a<i>b</i>&lt;3&gt;c", "a b<3>c"],
    ["<p>a</p><3>b", "<p>a</p>&lt;3&gt;b", "a<3>b"],
  ];

  it("四个形态：CDATA 路径不再插入源中不存在的空格（缺陷 R1 的直接钉）", () => {
    for (const [literal, , want] of forms) expect(contentOf(literal), `CDATA：${literal}`).toBe(want);
  });

  it("两路径同结果（R1 把 CDATA 路径改得和结构路径不一致，这条就是为它设的不变式）", () => {
    for (const [literal, xmlForm, want] of forms) {
      expect(contentOf(literal), `标记剥离路径：${literal}`).toBe(want);
      expect(structPath(xmlForm), `结构路径：${xmlForm}`).toBe(want);
    }
  });

  it("其余字面 '<' 形态同样不吞边界、不造空格（含『源里本来就有空格』的对照档）", () => {
    expect(contentOf("text<b></b><3>y")).toBe("text<3>y");
    expect(contentOf("<em>term</em><3>")).toBe("term<3>");
    expect(contentOf("word<b>bold</b><4>x")).toBe("word bold<4>x");
    expect(contentOf("a<b>x</b> <3>y")).toBe("a x <3>y"); // 源里的真空格保留，且只有一个
    expect(/  /.test(contentOf("A<em>x</em><3>B")), "字面 '<' 不得造出双空格").toBe(false);
  });

  it("串尾孤立 '<' / 连续 '<'：emit 之后边界必须被消费（R1 修法的反向对照）", () => {
    expect(contentOf("a<b>x</b><")).toBe("a x<");
    expect(contentOf("a<b>x</b><<y")).toBe("a x<<y"); // 旧行为给 "a x<< y"（空格落在字面 '<' 之后）
    expect(contentOf("a<b>x</b><!--")).toBe("a x<!--"); // 串尾未闭合注释整段留字面，且不造空格
  });
});

describe("r6-item2 Y12 全串无 '>' 的病态输入：lastGt 快退是零断言护栏，本轮补上（现版线性，删掉快退实测 39.4s）", () => {
  it("【第七轮 item3 秒级档】'<a href=z'×5000（45KB，全串无 '>'）⇒ 结果一字不改 + 耗时预算 500ms（护栏被删时 ~2.1s 就红）", () => {
    // 为什么要再加这一档：下面那条 ×20000 的大样本是【边界证据】（证明护栏在 0.17MiB 这个量级
    // 上真的做事），但它报警太慢——把 `if (c.lastGt <= i) return -1;` 删掉后，那条用例要跑满
    // 一百多秒才红（本机实测变异态 40.8s 纯计算 + 用例自身 3000ms 预算的判定）。有人删护栏
    // 之后等这条红的时间，长到会让人以为"没影响"。这一档用 1/4 规模（n² 代价 ⇒ 1/16 时间），
    // 健康态实测 ~6ms、变异态实测 ~2129ms ⇒ 预算 500ms：健康态有约 80 倍余量不会误报，
    // 护栏被删则【2 秒内必红】。大样本那条【保留不删】，两档一个管报警速度、一个管边界证据。
    const probe = "<a href=z".repeat(5000);
    expect(probe).not.toContain(">"); // 关键形态：全串无 '>'，才撞得到这条快退
    expect(probe.length).toBe(45000);
    const start = Date.now();
    const out = contentOf(probe);
    const elapsed = Date.now() - start;
    expect(out).toBe(probe); // 无 '>' ⇒ 每个 '<' 都按字面文本保留，一个字都不许改
    expect(elapsed, `耗时 ${elapsed}ms 超出线性预算（护栏健在实测个位数 ms；500ms 档 = 快退被删）`).toBeLessThan(500);
  }, 30_000);

  it("'<a href=z'×20000（0.17MiB，一个 '>' 都没有）⇒ 结果一字不改 + 耗时在线性预算内", () => {
    const probe = "<a href=z".repeat(20000);
    // 关键形态条件：全串【不含 '>'】。现有那条病态用例含 '>'，撞不到这条快退 —— 这正是它零覆盖的原因。
    expect(probe).not.toContain(">");
    expect(probe.length).toBe(180000);
    const start = Date.now();
    const out = contentOf(probe);
    const elapsed = Date.now() - start;
    expect(out).toBe(probe); // 无 '>' ⇒ 每个 '<' 都按字面文本保留，一个字都不许改
    // 预算 3000ms：现版实测约 40ms（2C 抖动留 70 倍余量），删掉 `if (c.lastGt <= i) return -1;`
    // 的变异档实测 39400ms ⇒ 这个上限既能杀掉变异，又不会因机器抖动误报。
    expect(elapsed, `耗时 ${elapsed}ms 超出线性预算（39s 档 = lastGt 快退被删）`).toBeLessThan(3000);
  }, 120_000);

  it("上下文与尺子单元：无 '>' 的串里 lastGt = -1，每个 '<' 都判散文", () => {
    const s = "<a href=z".repeat(50);
    const ctx = createMarkupScanContext(s);
    expect(ctx.lastGt).toBe(-1);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "<") expect(isWellFormedMarkupAt(s, i, ctx), `i=${i}`).toBe(-1);
    }
  });

  it("对照：只要串尾补一个 '>'，快退就不再适用（护栏管的是『再无 >』那一档，不是全部）", () => {
    const ctx = createMarkupScanContext("<a href=z>");
    expect(ctx.lastGt).toBe(9);
    expect(isWellFormedMarkupAt("<a href=z>", 0, ctx)).toBe(10); // 1 个裸属性 + 有 '>' ⇒ 仍是标记
  });
});

describe("r6-item3 Y17 大写闭合标签必须提供闭合证据：CLOSE_TAG_NAME 的 i 标志此前零断言", () => {
  it("老式大写 HTML（站点现实里不罕见）：闭合标签给了证据 ⇒ 开标签剥净，不留 <DIV> 残留", () => {
    expect(contentOf("文字<DIV>x</DIV>尾")).toBe("文字 x 尾");
    expect(contentOf("文字<SPAN>y</SPAN>尾")).toBe("文字 y 尾");
    expect(contentOf("a<DIV>b</DIV>c")).toBe("a b c");
  });

  it("大小写混排的两个方向都要有证据（开大闭小 / 开小闭大）", () => {
    expect(contentOf("文字<B>x</b>尾")).toBe("文字 x 尾");
    expect(contentOf("文字<b>x</B>尾")).toBe("文字 x 尾");
  });

  it("建表单元：大写闭合名同样进 closeNames（本地名 + 小写）；无闭合标签时表为空", () => {
    expect(createMarkupScanContext("a<DIV>b</DIV>c").closeNames.has("div")).toBe(true);
    expect(createMarkupScanContext("a</Div>b").closeNames.has("div")).toBe(true);
    expect(createMarkupScanContext("a<P>x</P>b").closeNames.has("p")).toBe(true);
    expect(createMarkupScanContext("a<b>x</b>c").closeNames.has("b")).toBe(true);
    expect(createMarkupScanContext("a<b>x").closeNames.size).toBe(0);
    // 前缀化闭合标签取本地名（</rss:item> 提供的是 item 的证据）
    expect(createMarkupScanContext("a<rss:item>x</rss:item>b").closeNames.has("item")).toBe(true);
  });
});

describe("r6-item5 死条件 !closing 已删：闭合标签从不吃守卫，这本身就是可断言的行为", () => {
  it("游离的闭合标签（全串没有对应开标签）照样被剥净 —— 它自己的名字就是闭合证据", () => {
    // 这条同时是 item5 的验收：删掉 !closing 后行为不变（守卫对 closing 恒不成立），
    // 而一旦建表正则丢了 `i`（见 r6-item3），闭合标签会被守卫判成散文 ⇒ 这里立刻变红。
    expect(contentOf("文字x</DIV>尾")).toBe("文字x 尾");
    expect(contentOf("文字x</div>尾")).toBe("文字x 尾");
    expect(contentOf("a</b>c")).toBe("a c");
    expect(contentOf("a</foo>bar")).toBe("a bar");
  });

  it("闭合标签带属性也照剥（attrCount 与它无关，守卫更管不到）", () => {
    expect(contentOf("a</div x>b")).toBe("a b");
    expect(contentOf("x</a>b")).toBe("x b");
  });

  it("自闭合标签不吃泛型守卫：`!selfClosing` 是【活判据】（变异体检 M13 逼出来的钉）", () => {
    // 第六轮变异体检：删掉守卫条件里的 `!selfClosing &&` ⇒ 236 全绿（当时的真实盲区）。
    // 自闭合形态天然没有闭合证据（`<b/>` 不等于 `</b>`），若让它进守卫，
    // `a<b/>c` 会被判散文而留下字面残留。这两条断言把该退化钉死。
    expect(contentOf("a<b/>c")).toBe("a c");
    expect(contentOf("词<foo/>尾")).toBe("词 尾");
    expect(contentOf("a<my-el/>b")).toBe("a b");
  });
});

describe("r6-item4 标识符出口【不吃泛型守卫】（主键稳定性；散文出口口径不变）", () => {
  const rssItem = (inner: string) =>
    '<rss version="2.0"><channel><title>T</title><item>' + inner + "</item></channel></rss>";
  const idOf = (inner: string) => parseFeed(rssItem(inner)).entries[0].id;
  const linkOfT = (inner: string) => parseFeed(rssItem("<title>t</title>" + inner)).entries[0].link;
  const rdf = (attrs: string, inner: string) =>
    '<rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">' +
    "<item" +
    attrs +
    ">" +
    inner +
    "</item></rdf:RDF>";

  it("① 主键稳定：guid 自身文本里【有无同名闭合标签】不再改变 id（复核点名的唯一残留静默风险）", () => {
    const pairs: Array<[string, string, string]> = [
      ["tag:x&lt;b&gt;1", "tag:x&lt;b&gt;1&lt;/b&gt;", "tag:x1"],
      ["urn:uuid:7&lt;div&gt;abc", "urn:uuid:7&lt;div&gt;abc&lt;/div&gt;", "urn:uuid:7abc"],
      ["https://x/a&lt;b&gt;c", "https://x/a&lt;b&gt;c&lt;/b&gt;", "https://x/ac"],
      ["https://e.com/p?w=800&lt;img&gt;", "https://e.com/p?w=800&lt;img&gt;&lt;/img&gt;", "https://e.com/p?w=800"],
    ];
    for (const [bare, closed, want] of pairs) {
      const noEvidence = idOf("<guid>" + bare + "</guid>");
      const withEvidence = idOf("<guid>" + closed + "</guid>");
      expect(noEvidence, `无闭合证据：${bare}`).toBe(want);
      expect(withEvidence, `有闭合证据：${closed}`).toBe(want);
      expect(noEvidence, `同字段有无闭合标签必须同值：${bare}`).toBe(withEvidence);
    }
  });

  it("①b 其余标识符出口同样稳定（link 文本 / link href / dc:identifier / rdf:about / enclosure url）", () => {
    // `<b>` 整段是标签 ⇒ 字母 b 随标签一起消失，只剩前后文本相接（"https://x/a" + "c" ⇒ "https://x/ac"）
    expect(linkOfT("<link>https://x/a&lt;b&gt;c</link>")).toBe("https://x/ac");
    expect(linkOfT("<link>https://x/a&lt;b&gt;c&lt;/b&gt;</link>")).toBe("https://x/ac");
    expect(linkOfT('<link href="https://x/a&lt;b&gt;c"/>')).toBe("https://x/ac");
    expect(linkOfT('<link href="https://x/a&lt;b&gt;c&lt;/b&gt;"/>')).toBe("https://x/ac");
    expect(parseFeed(rdf("", "<dc:identifier>doi:10.1/a&lt;b&gt;c</dc:identifier>")).entries[0].id).toBe("doi:10.1/ac");
    expect(
      parseFeed(rdf("", "<dc:identifier>doi:10.1/a&lt;b&gt;c&lt;/b&gt;</dc:identifier>")).entries[0].id,
    ).toBe("doi:10.1/ac");
    expect(parseFeed(rdf(' rdf:about="https://x/a&lt;b&gt;c"', "<title>t</title>")).entries[0].id).toBe("https://x/ac");
    expect(
      parseFeed(rdf(' rdf:about="https://x/a&lt;b&gt;c&lt;/b&gt;"', "<title>t</title>")).entries[0].id,
    ).toBe("https://x/ac");
    expect(parseFeed(rssItem('<enclosure url="https://cdn/a&lt;b&gt;c.mp3"/>')).entries[0].id).toBe(
      "https://cdn/ac.mp3",
    );
    expect(parseFeed(rssItem('<enclosure url="https://cdn/a&lt;b&gt;c.mp3&lt;/b&gt;"/>')).entries[0].id).toBe(
      "https://cdn/ac.mp3",
    );
  });

  it("② title 兜底改走【原始 title + 标识符口径】：id 紧凑、title 仍是散文（M-C 注释与代码终于一致）", () => {
    const structural = parseFeed(
      '<rss version="2.0"><channel><title>C</title><item><title>A<b>B</b>C</title></item></channel></rss>',
    ).entries[0];
    expect(structural.title).toBe("A B C"); // 散文口径：元素之间补分隔
    expect(structural.id).toBe("ABC"); // 标识符口径：不补（旧行为是拿散文 title 再洗一遍 ⇒ "A B C"）

    const escaped = parseFeed(
      '<rss version="2.0"><channel><title>C</title><item><title>A&lt;b&gt;B&lt;/b&gt;C</title></item></channel></rss>',
    ).entries[0];
    expect(escaped.id).toBe("ABC"); // 同一段 HTML 的两种源形态 ⇒ 同一个主键
    expect(escaped.title).toBe("A B C");

    const controlChars = parseFeed(
      '<rss version="2.0"><channel><title>C</title><item><title>We\u0007ird<b>x</b></title></item></channel></rss>',
    ).entries[0];
    expect(controlChars.title).toBe("We ird x"); // 散文：控制符换空格 + 补分隔
    expect(controlChars.id).toBe("Weirdx"); // 标识符：控制符删除 + 不补分隔
  });

  it("③ 散文出口继续吃守卫（本轮只动标识符出口，比较/泛型语义照旧保住）", () => {
    expect(contentOf("变量 a<b>c 时")).toBe("变量 a<b>c 时");
    expect(contentOf("std::vector<int> v;")).toBe("std::vector<int> v;");
    // 同一段文本进 title：散文口径保住字面比较语义；标识符口径不吃守卫 ⇒ 那一处 <b> 被剥（代价见 ⑤）
    const entry = parseFeed(
      '<rss version="2.0"><channel><title>C</title><item><title>变量 a&lt;b&gt;c 时</title></item></channel></rss>',
    ).entries[0];
    expect(entry.title).toBe("变量 a<b>c 时");
    expect(entry.id).toBe("变量 ac 时");
  });

  it("④ 标识符出口仍保留守卫之外的两条判据（数字开头 / 多个裸属性 ⇒ 照旧留字面）", () => {
    expect(idOf("<guid>http://e.com/1&lt;2&gt;0</guid>")).toBe("http://e.com/1<2>0");
    expect(idOf("<guid>id&lt;1abc&gt;x&lt;/1abc&gt;</guid>")).toBe("id<1abc>x</1abc>");
    expect(idOf("<guid>x&lt;a href=1 y z&gt;c</guid>")).toBe("x<a href=1 y z>c");
  });

  it("⑤【申报·有意如此】标识符出口放弃泛型保护：guid 里的 List<T> 会被剥成 List（口径代价，别当 bug 改回去）", () => {
    expect(idOf("<guid>List&lt;T&gt;item</guid>")).toBe("Listitem");
    expect(idOf("<guid>std::vector&lt;int&gt;v</guid>")).toBe("std::vectorv");
    // 对照：散文出口同样输入照旧保住（两条口径分开的正是这一档）
    expect(contentOf("std::vector<int> v;")).toBe("std::vector<int> v;");
  });

  it("⑤b【申报·有意如此】放弃守卫的【后果】：两个不同的源值 collapse 成同一主键 ⇒ 同源两条并成一条（改回去 = 重新引入 guid 翻转）", () => {
    // ── 为什么这条断言必须存在 ──
    // ⑤ 只申报了【机理】（`List<T>` → `List`），没申报【后果】：守卫一让，两个本来不同的
    // 源值可能清洗成同一个主键。不钉住并写清取舍，将来一定有人当 bug"顺手修回去"——
    // 而修回去就是第五轮那个坑：guid 取值取决于【该字段自身文本里有没有同名闭合标签】，
    // 源站改一次正文就换一次主键 ⇒ 下游按 id 去重失效 ⇒ 同一篇文章重复入库，改一次换一个键。
    // 两个方向的风险对比（这就是选前者的理由）：
    //   · collapse：概率低（要同源同时出现两种写法且恰好撞键）＋后果有界（条目数 -1，其余
    //     字段按第五轮 M-E 的字段并集【补空位】保留；见下面 toEqual 的实测）＋源站写法一改
    //     自然消失，不会持续产生新脏 ⇒ 可容忍。
    //   · 换键：概率高（正文天天改）＋后果是不可逆的重复入库（同文两条、且每改一次再换一次
    //     键，脏数据持续累积、无法回收）⇒ 不可容忍。
    // ⇒ 宁可极少数撞键合并，不可高频换键重复。本条是【有意如此】的口径，不是缺陷。

    // ① 两个【不同源值】落进【同一个主键】（实测，非推演）
    const escaped = idOf("<guid>https://x/a&lt;b&gt;c</guid>"); // 双层转义写法（&lt;b&gt; 解出 <b> 后被守卫放宽剥掉）
    const plain = idOf("<guid>https://x/ac</guid>"); // 明文写法
    expect(escaped).toBe("https://x/ac");
    expect(plain).toBe("https://x/ac");
    expect(escaped).toBe(plain); // ← 这一句就是"collapse 有意如此"的钉子

    // ② 同一份源里两种写法同时出现 ⇒ 两条本不相同的 item 合并成一条（实测条数 / id / 字段）
    const merged = parseFeed(
      '<rss version="2.0"><channel><title>源标题</title>' +
        "<item><guid>https://x/a&lt;b&gt;c</guid><title>甲条（双层转义写法）</title>" +
        "<description>只有甲条有的正文A</description><link>https://x/link-jia</link></item>" +
        "<item><guid>https://x/ac</guid><title>乙条（明文写法）</title>" +
        "<summary>只有乙条有的摘要B</summary><pubDate>Tue, 30 Sep 2025 01:00:00 +0000</pubDate></item>" +
        "</channel></rss>",
    );
    // 条数：2 → 1（这就是 collapse 的代价，如实钉住；不是"解析丢条目"，是撞键后按 id 合并）
    expect(merged.entries).toHaveLength(1);
    // 字段：id 用撞出来的那个；两边互补的字段都保住（乙的 pubDate 补进空位）；
    // 冲突字段取"更完整者为底"（甲），所以乙的摘要B 不进记录 —— 与 M-E 的补空位口径一致。
    expect(merged.entries[0]).toEqual({
      id: "https://x/ac",
      title: "甲条（双层转义写法）",
      link: "https://x/link-jia",
      publishedAt: new Date("2025-09-30T01:00:00.000Z"),
      summary: "只有甲条有的正文A",
      content: "只有甲条有的正文A",
    });

    // ③ 对照：散文出口【不 collapse】——同一段文本进 title 照旧保住字面 `<b>`，
    // 两条口径分开正是为了让"正文改一个 </div>"不影响主键、也不影响散文的读感。
    const prose = parseFeed(
      '<rss version="2.0"><channel><title>C</title>' +
        "<item><guid>g-1</guid><title>路径 a&lt;b&gt;c 在这里保住字面</title></item>" +
        "<item><guid>g-2</guid><title>路径 ac</title></item>" +
        "</channel></rss>",
    );
    expect(prose.entries.map((e) => e.title)).toEqual([
      "路径 a<b>c 在这里保住字面",
      "路径 ac",
    ]);
  });

  it("⑥ 出口不变式在新口径下仍然成立：真实固件每条 id/link 两把尺零命中", () => {
    for (const feed of [parseFeed(hnRss2), parseFeed(natureRdf), parseFeed(redditAtom)]) {
      for (const entry of feed.entries) {
        for (const value of [entry.id, entry.link]) {
          if (!value) continue;
          expect(findMarkupStart(value)).toBe(-1);
          expectNoWideMarkup(value, "真实固件标识符出口（宽尺）");
          expect(value).toBe(value.trim());
          expect(/  /.test(value)).toBe(false);
        }
      }
    }
  });
});

describe("r6-item6 错误文案钉 + 三处申报用例化", () => {
  const grab = (xml: string): { name: string; message: string } => {
    try {
      parseFeed(xml);
    } catch (e) {
      const err = e as Error;
      return { name: err.name, message: err.message };
    }
    throw new Error("期望抛错但 parseFeed 正常返回了");
  };

  it("NotAFeedError：类型 + 三条文案全部钉死（此前只断言类型，措辞漂移无人管）", () => {
    expect(grab("").name).toBe("NotAFeedError");
    expect(grab("").message).toMatch(/^输入为空，无法识别为 feed$/);
    expect(grab('{"hello": "world"}').message).toMatch(
      /^输入不是合法 XML，也找不到 rss \/ rdf:RDF \/ feed 根标签，可能不是 RSS\/Atom 数据源$/,
    );
    expect(grab("<!DOCTYPE html><html><body><p>hello</p></body></html>").message).toMatch(
      /^根标签不是 rss \/ rdf:RDF \/ feed，输入可能不是 RSS\/Atom 数据源（顶层节点:\s*html）$/,
    );
  });

  it("MalformedXMLError：类型 + 文案前缀钉死（尾部带解析器原始报错，不锁死它）", () => {
    const err = grab("<rss><channel><title>T</title><item><title>x</title>");
    expect(err.name).toBe("MalformedXMLError");
    expect(err.message).toMatch(/^feed 语法有瑕疵，无法解析（如标签未闭合\/非法字符）: .+/);
    expect(() => parseFeed("<rss><channel><title>T</title><item><title>x</title>")).toThrowError(MalformedXMLError);
  });

  it("申报①：守卫的『紧贴』判据只看前一个字符 ⇒ f(x)<y>z / \"a\"<b>c / a <b>c 会被吞（不为它放宽判据）", () => {
    expect(contentOf("f(x)<y>z")).toBe("f(x) z");
    expect(contentOf('"a"<b>c')).toBe('"a" c');
    expect(contentOf("a <b>c")).toBe("a c");
    // 对照：紧贴标识符字符才是守卫认的那一档
    expect(contentOf("a<b>c")).toBe("a<b>c");
    expect(contentOf("1<b>c")).toBe("1<b>c");
  });

  it("申报②：注释/声明/PI 仍受 4096 跨度上限 ⇒ 超长那一段整块进正文（数量级样本：100KB 注释）", () => {
    const comment = contentOf("A<!--" + "u".repeat(100000) + "-->B");
    expect(comment.length).toBeGreaterThan(100000); // 实测 100009 字注释体进了正文
    expect(comment).toContain("<!--");
    const decl = contentOf("A<!DOCTYPE " + "d".repeat(100000) + ">B");
    expect(decl.length).toBeGreaterThan(100000);
    const pi = contentOf("A<?pi " + "p".repeat(100000) + "?>B");
    expect(pi.length).toBeGreaterThan(100000);
  });

  it("申报③：独立宽尺是【测试语料回归网】，不是运行期拦截 ⇒ 真实源里同类脏照样入库、不抛、不丢条目", () => {
    const dirty =
      '<rss version="2.0"><channel><title>T</title><item><guid>g1</guid>' +
      "<description><![CDATA[x <a href=x y z>y]]></description></item></channel></rss>";
    const entry = parseFeed(dirty).entries[0];
    expect(entry.content).toBe("x <a href=x y z>y");
    expect(wideMarkupSpans(entry.content)).toEqual(["<a"]); // 宽尺会抓到它 —— 但那只发生在测试里
    expect(entry.id).toBe("g1");
  });
});
