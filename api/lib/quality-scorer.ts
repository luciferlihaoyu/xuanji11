/**
 * 文档质量评分：纯确定性规则（不依赖 LLM），入库时即时计算。
 *
 * 评分维度（总分 100）：
 *   来源完整性 15 / 标题质量 15 / 正文长度 20 / 解析完整性 15 /
 *   非乱码比例 15 / 日期有效性 10 / 重复程度 10
 *
 * 用途：
 * - ≥70：正常入库默认搜索
 * - 40-70：进收件箱（quality kind）提示人工看
 * - <40：保留原文但建议不进入默认搜索
 */
import { hashContent } from "./doc-versioning";
import { findDocumentByContentHash } from "./ingestion-idempotency";

export interface QualityIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
}

export interface QualityReport {
  score: number;
  level: "good" | "review" | "poor";
  issues: QualityIssue[];
}

export interface QualityInput {
  title: string;
  content: string | null | undefined;
  source?: string | null;
  createdAt?: Date | null;
}

export async function scoreDocumentQuality(input: QualityInput): Promise<QualityReport> {
  const issues: QualityIssue[] = [];
  let score = 100;
  const content = (input.content ?? "").trim();
  const title = (input.title ?? "").trim();

  // 来源完整性（15）
  if (!input.source) {
    score -= 15;
    issues.push({ code: "no_source", severity: "warning", message: "缺少来源" });
  }

  // 标题质量（15）
  if (title.length === 0) {
    score -= 15;
    issues.push({ code: "empty_title", severity: "error", message: "标题为空" });
  } else if (/^(untitled|未命名|新建文档|document|无标题)/i.test(title)) {
    score -= 10;
    issues.push({ code: "generic_title", severity: "warning", message: "标题过于泛化（未命名类）" });
  } else if (title.length < 4) {
    score -= 8;
    issues.push({ code: "short_title", severity: "warning", message: "标题过短" });
  }

  // 正文长度（20）
  if (content.length === 0) {
    score -= 20;
    issues.push({ code: "empty_content", severity: "error", message: "正文为空" });
  } else if (content.length < 50) {
    score -= 12;
    issues.push({ code: "thin_content", severity: "warning", message: `正文过短（${content.length} 字符）` });
  }

  // 乱码比例（15）：统计替换字符/控制字符占比
  if (content.length > 0) {
    const garbled = (content.match(/[\u0000-\u001f�]/g) ?? []).length;
    const ratio = garbled / content.length;
    if (ratio > 0.05) {
      score -= 15;
      issues.push({ code: "garbled", severity: "error", message: `乱码比例过高（${(ratio * 100).toFixed(1)}%）` });
    } else if (ratio > 0.01) {
      score -= 8;
      issues.push({ code: "some_garbled", severity: "warning", message: "存在少量乱码" });
    }
  }

  // 日期有效性（10）：未来超过 1 天的日期视为异常
  if (input.createdAt && input.createdAt.getTime() > Date.now() + 24 * 3600 * 1000) {
    score -= 10;
    issues.push({ code: "future_date", severity: "warning", message: "创建日期在未来" });
  }

  // 重复程度（10）：exact hash 已有同内容文档
  if (content.length > 0) {
    try {
      const existingId = await findDocumentByContentHash(hashContent(content));
      if (existingId !== null) {
        score -= 10;
        issues.push({ code: "exact_duplicate", severity: "warning", message: `与文档 #${existingId} 内容完全相同` });
      }
    } catch { /* 幂等表未就绪时跳过 */ }
  }

  score = Math.max(0, score);
  const level = score >= 70 ? "good" : score >= 40 ? "review" : "poor";
  return { score, level, issues };
}
