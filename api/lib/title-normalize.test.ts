import { describe, it, expect } from "vitest";
import { normalizeTitle } from "./title-normalize";

describe("normalizeTitle", () => {
  it("空串 → 空串", () => {
    expect(normalizeTitle("")).toBe("");
    expect(normalizeTitle("   ")).toBe("");
  });

  it("纯空白 → 空串", () => {
    expect(normalizeTitle("\t\n  ")).toBe("");
  });

  it("无前缀普通标题保持原意", () => {
    expect(normalizeTitle("Hello World")).toBe("hello world");
  });

  it("单个 [xxx] 前缀被剥除", () => {
    expect(normalizeTitle("[OpenClaw记忆/public/共享知识] 场景: xxx")).toBe("场景: xxx");
  });

  it("多个连续 [xxx] 前缀都剥除", () => {
    expect(normalizeTitle("[a][b] title")).toBe("title");
    expect(normalizeTitle("[foo][bar][baz] content")).toBe("content");
  });

  it("前缀 + 中文标题正确处理", () => {
    expect(normalizeTitle("[标签1] 璇玑记忆系统")).toBe("璇玑记忆系统");
    expect(normalizeTitle("[记忆][归档] 项目: xuanji")).toBe("项目: xuanji");
  });

  it("多余空白折叠为单空格", () => {
    expect(normalizeTitle("foo   bar")).toBe("foo bar");
    expect(normalizeTitle("foo\t\nbar")).toBe("foo bar");
  });

  it("首尾空白被 trim", () => {
    expect(normalizeTitle("  hello  ")).toBe("hello");
  });

  it("大小写归一为小写", () => {
    expect(normalizeTitle("Hello World")).toBe("hello world");
    expect(normalizeTitle("ABCdef")).toBe("abcdef");
  });

  it("剥离前缀后多余空白也折叠", () => {
    expect(normalizeTitle("[tag]   hello   world   ")).toBe("hello world");
  });

  it("不带前缀的纯中文标题 + 大小写归一（中文无大小写但流程要跑通）", () => {
    expect(normalizeTitle("  璇玑  记忆  ")).toBe("璇玑 记忆");
  });

  it("不剥中段 [xxx]，只剥开头", () => {
    expect(normalizeTitle("foo [bar] baz")).toBe("foo [bar] baz");
  });
});
