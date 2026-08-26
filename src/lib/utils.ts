import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 存储饼图分段键。 */
export interface StorageSegment {
  key: "documents" | "vectors" | "backups";
  label: string;
  value: string;
  pct: number; // 0-100，按数值占比；单一段时 100
}

/**
 * 按实际存储数值计算饼图各段百分比。
 * 输入均为空（无任何统计数据）时返回 null —— 调用方应隐藏饼图而非展示假比例。
 * 数值支持纯字节数或带 K/M/G 后缀的字符串（不区分大小写）。
 */
export function computeStorageRatios(
  documents: string,
  vectors: string,
  backups: string
): StorageSegment[] | null {
  const parse = (raw: string): number => {
    if (!raw) return 0;
    const m = raw.trim().match(/^([\d.]+)\s*([kmg])?b?$/i);
    if (!m) return Number(raw.replace(/[^\d.]/g, "")) || 0;
    const base = Number.parseFloat(m[1]);
    if (!Number.isFinite(base)) return 0;
    const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]?.toLowerCase() ?? ""] ?? 1;
    return base * mult;
  };

  const segments = [
    { key: "documents" as const, label: "文档", raw: documents },
    { key: "vectors" as const, label: "向量", raw: vectors },
    { key: "backups" as const, label: "备份", raw: backups },
  ];
  const values = segments.map((s) => ({ ...s, num: parse(s.raw), value: s.raw }));
  const total = values.reduce((acc, v) => acc + v.num, 0);
  if (total <= 0) return null;

  return values.map((v) => ({
    key: v.key,
    label: v.label,
    value: v.value,
    pct: total > 0 ? Math.round((v.num / total) * 1000) / 10 : 0,
  }));
}
