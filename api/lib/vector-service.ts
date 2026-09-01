/**
 * 璇玑向量引擎服务层 — SQLite + sqlite-vec 持久化，统一内存兜底。
 * 原 @zvec/zvec 引擎已替换为 api/lib/vector-engine.ts 中的 SqliteVecEngine。
 */

// allow: SIZE_OK — 向量引擎是持有私有可变状态（VectorEngine 单例 / 嵌入配置缓存）的单体模块；
// 嵌入配置、请求、解析逻辑是 vectorEngine 的私有辅助函数；拆分会暴露内部状态并增加耦合。

import { eq, desc } from "drizzle-orm";
import { systemSettings, vectorCollections, type VectorCollection } from "@db/schema";
import { env } from "./env";
import { assertEgressAllowed } from "./egress";
import { tianshuApiUrl, tianshuApiKey, tianshuEnabled } from "./tianshu";
import { getDb, getRawDb } from "../queries/connection";
import { getVectorEngine, recreateVectorEngine, type VectorEngine } from "./vector-engine";
import { randomUUID } from "crypto";

function simpleTextHash(text: string, dims: number = 64): number[] {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dims] += (code / 65535) * 2 - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

interface EmbeddingConfig {
  enabled: boolean;
  url: string;
  key: string;
  model: string;
  dimension: number;
  templateId?: string;
  templateName?: string;
}

export type VectorModelProvider = "openai" | "minimax" | "local" | "custom";

export interface VectorModelConfigInput {
  readonly provider?: VectorModelProvider;
  readonly customProviderName?: string;
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimension?: number;
}

export interface VectorModelTemplateInput extends VectorModelConfigInput {
  readonly id?: string;
  readonly name: string;
  readonly indexMode?: string;
  readonly similarityThreshold?: string;
}

interface VectorModelTemplate extends VectorModelTemplateInput {
  readonly id: string;
  readonly apiKey: string;
  readonly lastTestOk?: boolean;
  readonly lastTestMessage?: string;
  readonly lastTestedAt?: string;
}

export interface VectorModelTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly provider: VectorModelProvider;
  readonly customProviderName?: string;
  readonly apiUrl: string;
  readonly model: string;
  readonly dimension: number;
  readonly indexMode?: string;
  readonly similarityThreshold?: string;
  readonly hasApiKey: boolean;
  readonly lastTestOk?: boolean;
  readonly lastTestMessage?: string;
  readonly lastTestedAt?: string;
  readonly isActive: boolean;
}

export interface VectorModelTestResult {
  readonly ok: boolean;
  readonly provider: string;
  readonly model: string;
  readonly dimension?: number;
  readonly status?: number;
  readonly resolvedUrl?: string;
  readonly error?: string;
}

export interface VectorHealthStatus {
  readonly ok: boolean;
  readonly engine: string;
  readonly size: number;
  readonly mode: "empty" | "indexed";
  readonly provider: string;
  readonly model: string;
  readonly dimension?: number;
  readonly error?: string;
  readonly fallbackTemplateId?: string;
  readonly fallbackTemplateName?: string;
  readonly zvecEnabled: boolean;
  readonly zvecDataDir: string;
  readonly zvecDimension: number;
  readonly collectionName: string;
}

class EmbeddingApiError extends Error {
  readonly name = "EmbeddingApiError";
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

interface StoredVectorTemplates {
  readonly templates: readonly VectorModelTemplate[];
}

const vectorTemplateListKey = "embedding_model_templates";
const activeVectorTemplateKey = "embedding_active_template_id";
const legacyEmbeddingKeys = ["embedding_api_url", "embedding_api_key", "embedding_model", "embedding_dimension"] as const;

type EmbeddingProvider = "openai" | "volcengine";

function detectProvider(url: string): EmbeddingProvider {
  try {
    const u = new URL(url);
    if (u.hostname.includes("ark.cn-beijing.volces.com")) {
      // Agent Plan uses its own OpenAI-compatible endpoint (/api/plan/v3/embeddings)
      // with standard string-array input, NOT Volcengine's multimodal format.
      if (u.pathname.includes("/api/plan")) return "openai";
      return "volcengine";
    }
  } catch {
    // fall through to default
  }
  return "openai";
}

export function normalizeEmbeddingUrl(url: string, provider: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/embeddings")) return trimmed;
  if (provider === "volcengine" && !trimmed.includes("/api/plan")) return `${trimmed}/embeddings/multimodal`;
  return `${trimmed}/embeddings`;
}

function defaultEmbeddingDimension(_model: string): number {
  // Return a sensible default that can always be overridden by the user's setting.
  // We don't force the dimension to any specific value for any model anymore —
  // the user controls it via the `embedding_dimension` setting.
  return 1536;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeProvider(value: unknown): VectorModelProvider {
  switch (value) {
    case "openai":
    case "minimax":
    case "local":
    case "custom":
      return value;
    default:
      return "openai";
  }
}

function parseDimension(value: unknown, model: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : defaultEmbeddingDimension(model);
}

function configFromInput(input: VectorModelConfigInput): EmbeddingConfig {
  const model = input.model || "text-embedding-3-small";
  return {
    enabled: Boolean(input.apiUrl && input.apiKey),
    url: input.apiUrl,
    key: input.apiKey,
    model,
    dimension: parseDimension(input.dimension, model),
  };
}

function configFromTemplate(template: VectorModelTemplate): EmbeddingConfig {
  const cfg = configFromInput(template);
  return { ...cfg, templateId: template.id, templateName: template.name };
}

function parseTemplate(value: unknown): VectorModelTemplate | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  const apiUrl = optionalString(value.apiUrl);
  const model = optionalString(value.model);
  if (!id || !name || !apiUrl || !model) return undefined;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey : "";
  return {
    id,
    name,
    provider: normalizeProvider(value.provider),
    customProviderName: optionalString(value.customProviderName),
    apiUrl,
    apiKey,
    model,
    dimension: parseDimension(value.dimension, model),
    indexMode: optionalString(value.indexMode),
    similarityThreshold: optionalString(value.similarityThreshold),
    lastTestOk: typeof value.lastTestOk === "boolean" ? value.lastTestOk : undefined,
    lastTestMessage: optionalString(value.lastTestMessage),
    lastTestedAt: optionalString(value.lastTestedAt),
  };
}

function parseTemplateStore(value: string | null | undefined): readonly VectorModelTemplate[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !Array.isArray(parsed.templates)) return [];
    return parsed.templates.map(parseTemplate).filter((item): item is VectorModelTemplate => item !== undefined);
  } catch (err) {
    console.warn("[VectorEngine] Failed to parse vector templates:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function getSettingValue(key: string): Promise<string | undefined> {
  const row = await getDb().select().from(systemSettings).where(eq(systemSettings.key, key));
  return row[0]?.value ?? undefined;
}

async function upsertSettingValue(key: string, value: string, category = "vectorization"): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  if (existing.length > 0) {
    await db.update(systemSettings).set({ value, category }).where(eq(systemSettings.key, key));
    return;
  }
  await db.insert(systemSettings).values({ key, value, category });
}

async function readVectorTemplates(): Promise<readonly VectorModelTemplate[]> {
  return parseTemplateStore(await getSettingValue(vectorTemplateListKey));
}

async function writeVectorTemplates(templates: readonly VectorModelTemplate[]): Promise<void> {
  const store: StoredVectorTemplates = { templates };
  await upsertSettingValue(vectorTemplateListKey, JSON.stringify(store));
}

async function getActiveTemplateId(): Promise<string | undefined> {
  return getSettingValue(activeVectorTemplateKey);
}

function maskTemplate(template: VectorModelTemplate, activeId: string | undefined): VectorModelTemplateSummary {
  return {
    id: template.id,
    name: template.name,
    provider: template.provider ?? "openai",
    customProviderName: template.customProviderName,
    apiUrl: template.apiUrl,
    model: template.model,
    dimension: template.dimension ?? defaultEmbeddingDimension(template.model),
    indexMode: template.indexMode,
    similarityThreshold: template.similarityThreshold,
    hasApiKey: template.apiKey.length > 0,
    lastTestOk: template.lastTestOk,
    lastTestMessage: template.lastTestMessage,
    lastTestedAt: template.lastTestedAt,
    isActive: template.id === activeId,
  };
}

function getEmbeddingConfig(): EmbeddingConfig {
  // 显式 LLM_* 优先，未配置时回落到天枢 (Tianshu) 网关
  const url = process.env.LLM_API_URL || (tianshuEnabled() ? tianshuApiUrl() : "");
  const key = process.env.LLM_API_KEY || tianshuApiKey();
  const model = process.env.EMBEDDING_MODEL || process.env.TIANSHU_EMBEDDING_MODEL || "text-embedding-3-small";
  const rawDim = process.env.EMBEDDING_DIMENSION;
  const parsed = rawDim != null ? parseInt(rawDim, 10) : 0;
  const dimension = parsed > 0 ? parsed : defaultEmbeddingDimension(model);
  return { enabled: Boolean(url && key), url, key, model, dimension };
}

async function loadLegacyEmbeddingConfig(): Promise<EmbeddingConfig> {
  const settings = new Map<string, string>();
  for (const key of legacyEmbeddingKeys) {
    const value = await getSettingValue(key);
    if (value) settings.set(key, value);
  }
  const url = settings.get("embedding_api_url") || process.env.LLM_API_URL || (tianshuEnabled() ? tianshuApiUrl() : "");
  const key = settings.get("embedding_api_key") || process.env.LLM_API_KEY || tianshuApiKey();
  const model = settings.get("embedding_model") || process.env.EMBEDDING_MODEL || process.env.TIANSHU_EMBEDDING_MODEL || "text-embedding-3-small";
  const dimension = parseDimension(settings.get("embedding_dimension") || process.env.EMBEDDING_DIMENSION, model);
  return { enabled: Boolean(url && key), url, key, model, dimension };
}

async function loadEmbeddingConfig(): Promise<EmbeddingConfig> {
  try {
    const activeId = await getActiveTemplateId();
    const templates = await readVectorTemplates();
    const activeTemplate = templates.find((template) => template.id === activeId && template.apiKey.length > 0);
    if (activeTemplate) return configFromTemplate(activeTemplate);
    return loadLegacyEmbeddingConfig();
  } catch (err) {
    console.warn("[VectorEngine] Failed to load embedding config from DB, falling back to env:", err instanceof Error ? err.message : String(err));
    return getEmbeddingConfig();
  }
}

async function fetchEmbeddingsWithConfig(texts: readonly string[], cfg: EmbeddingConfig): Promise<number[][]> {
  if (!cfg.enabled) throw new Error("Embedding provider not configured");
  const provider = detectProvider(cfg.url);
  const endpoint = normalizeEmbeddingUrl(cfg.url, provider);
  const isMultimodal = provider === "volcengine" && !endpoint.includes("/api/plan");
  const body = isMultimodal
    ? { model: cfg.model, input: texts.map((text) => ({ type: "text", text })), encoding_format: "float", ...(cfg.model.includes("doubao-embedding-vision") ? { dimensions: cfg.dimension } : {}) }
    : { input: texts, model: cfg.model, encoding_format: "float" };
  // SSRF guard：嵌入端点来自用户可配置模板，默认禁私网（EGRESS_ALLOW_PRIVATE_NET=true 放行内网 LLM）
  await assertEgressAllowed(endpoint);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
  });
  const rawText = await res.text().catch(() => "");
  const payload = (() => { try { return JSON.parse(rawText); } catch { return undefined; } })();
  const errPayload = payload as { error?: { code?: string; message?: string } } | undefined;
  const errorMessage = errPayload?.error?.message
    ? `${errPayload.error.code ?? "error"}: ${errPayload.error.message}`
    : `HTTP ${res.status}`; // 不回显远端响应体（防内网响应探测）
  if (!res.ok) {
    throw new EmbeddingApiError(`Embedding API ${res.status}: ${errorMessage}`, res.status, endpoint);
  }
  if (errPayload?.error?.message) {
    throw new EmbeddingApiError(`${errPayload.error.code ?? "Embedding API error"}: ${errPayload.error.message}`, res.status, endpoint);
  }
  const data = payload as { data?: Array<{ embedding?: number[] | number[][]; index?: number }> } | undefined;
  const embeddings = (data?.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => {
    if (!isMultimodal) return Array.isArray(d.embedding) ? (d.embedding as number[]) : [];
    const nested = Array.isArray(d.embedding) ? (d.embedding as number[][])[0] : undefined;
    return Array.isArray(nested) ? nested : [];
  });
  if (embeddings.length !== texts.length) throw new Error(`Embedding API returned ${embeddings.length} vectors for ${texts.length} texts`);
  return embeddings;
}

async function embeddingCandidates(): Promise<EmbeddingConfig[]> {
  const templates = await readVectorTemplates();
  const activeId = await getActiveTemplateId();
  const orderedTemplates = [
    ...templates.filter((template) => template.id === activeId),
    ...templates.filter((template) => template.id !== activeId && template.apiKey.length > 0),
  ];
  const candidates = orderedTemplates.map(configFromTemplate);
  candidates.push(await loadLegacyEmbeddingConfig());
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.enabled) return false;
    const key = candidate.templateId ?? `${candidate.url}\n${candidate.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function embedWithFallback(texts: string[]): Promise<number[][]> {
  const candidates = await embeddingCandidates();
  for (const cfg of candidates) {
    try {
      return await fetchEmbeddingsWithConfig(texts, cfg);
    } catch (err) {
      const label = cfg.templateName ?? cfg.model;
      console.warn(`[VectorEngine] Embedding model ${label} failed, trying fallback:`, err instanceof Error ? err.message : String(err));
    }
  }
  return texts.map((t) => simpleTextHash(t, 64));
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export async function testEmbeddingConfig(input: VectorModelConfigInput): Promise<VectorModelTestResult> {
  const cfg = configFromInput(input);
  const provider = input.provider === "custom" && input.customProviderName ? input.customProviderName : input.provider ?? detectProvider(cfg.url);
  if (!cfg.enabled) return { ok: false, provider, model: cfg.model, error: "Embedding provider not configured" };
  const resolvedUrl = normalizeEmbeddingUrl(cfg.url, detectProvider(cfg.url));
  try {
    const [vector] = await fetchEmbeddingsWithConfig(["ping"], cfg);
    return { ok: true, provider, model: cfg.model, dimension: vector?.length, resolvedUrl };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const status = err instanceof EmbeddingApiError ? err.status : undefined;
    return { ok: false, provider, model: cfg.model, error, status, resolvedUrl };
  }
}

export async function listVectorModelTemplates(): Promise<readonly VectorModelTemplateSummary[]> {
  const [templates, activeId] = await Promise.all([readVectorTemplates(), getActiveTemplateId()]);
  return templates.map((template) => maskTemplate(template, activeId));
}

export async function getVectorModelTemplate(id: string): Promise<VectorModelTemplate | null> {
  const templates = await readVectorTemplates();
  return templates.find((template) => template.id === id) ?? null;
}

export async function saveVectorModelTemplate(input: VectorModelTemplateInput): Promise<VectorModelTemplateSummary> {
  const templates = await readVectorTemplates();
  const existing = input.id ? templates.find((template) => template.id === input.id) : undefined;
  const id = input.id ?? randomUUID();
  const apiKey = input.apiKey.length > 0 ? input.apiKey : existing?.apiKey ?? "";
  const template: VectorModelTemplate = {
    id,
    name: input.name,
    provider: input.provider ?? existing?.provider ?? "openai",
    customProviderName: input.customProviderName,
    apiUrl: input.apiUrl,
    apiKey,
    model: input.model,
    dimension: parseDimension(input.dimension, input.model),
    indexMode: input.indexMode,
    similarityThreshold: input.similarityThreshold,
    lastTestOk: existing?.lastTestOk,
    lastTestMessage: existing?.lastTestMessage,
    lastTestedAt: existing?.lastTestedAt,
  };
  const next = existing
    ? templates.map((item) => item.id === id ? template : item)
    : [...templates, template];
  await writeVectorTemplates(next);
  const activeId = await getActiveTemplateId();
  return maskTemplate(template, activeId);
}

export async function deleteVectorModelTemplate(id: string): Promise<void> {
  const [templates, activeId] = await Promise.all([readVectorTemplates(), getActiveTemplateId()]);
  await writeVectorTemplates(templates.filter((template) => template.id !== id));
  if (activeId === id) await upsertSettingValue(activeVectorTemplateKey, "");
}

export async function selectVectorModelTemplate(id: string): Promise<VectorModelTemplateSummary> {
  const template = await getVectorModelTemplate(id);
  if (!template) throw new Error(`Vector model template not found: ${id}`);
  await Promise.all([
    upsertSettingValue(activeVectorTemplateKey, id),
    upsertSettingValue("embedding_provider", template.provider ?? "openai"),
    upsertSettingValue("embedding_api_url", template.apiUrl),
    upsertSettingValue("embedding_api_key", template.apiKey),
    upsertSettingValue("embedding_model", template.model),
    upsertSettingValue("embedding_dimension", String(template.dimension ?? defaultEmbeddingDimension(template.model))),
  ]);
  return maskTemplate(template, id);
}

export async function markVectorModelTemplateTest(id: string, result: VectorModelTestResult): Promise<void> {
  const templates = await readVectorTemplates();
  const next = templates.map((template) => template.id === id
    ? { ...template, lastTestOk: result.ok, lastTestMessage: result.ok ? "连接成功" : result.error, lastTestedAt: new Date().toISOString() }
    : template);
  await writeVectorTemplates(next);
}

// ==================== 向量引擎异步初始化 ====================
// 修复 R3 引入的维度不匹配 bug：
// 旧实现里 vectorEngine 在 module top-level 用 env.zvecDimension(默认 1536) 同步初始化，
// 但用户的 embedding 模型（如 doubao-embedding-vision）实际输出 1024 维向量，
// 导致 vec_chunks 表用 1536 维建好但写入 1024 维向量被 vec0 拒绝，表现为"reindex 完成但 0 条向量"。
//
// 修复：vectorEngine 改为可变单例 + ensureCorrectDimension() 在使用前异步读取
// system_settings.embedding_dimension 拿到真实 dim，若与已建表不一致则 drop 旧表并重建。
let vectorEngineInstance: VectorEngine = getVectorEngine(env.zvecDimension);
export const vectorEngine: VectorEngine = new Proxy({} as VectorEngine, {
  get(_target, prop) {
    return (vectorEngineInstance as unknown as Record<string | symbol, unknown>)[prop];
  },
});

let dimensionInitialized = false;
let dimensionInitPromise: Promise<void> | null = null;

/**
 * 在使用向量引擎前调用：异步从 system_settings 读取真实 dim，
 * 若与现有 vec_chunks 表不一致则 drop 旧表 + 重建（vec0 虚拟表维表不可改）。
 * 幂等：并发调用只执行一次；dim 匹配时直接跳过。
 */
export async function ensureCorrectDimension(): Promise<void> {
  if (dimensionInitialized) return;
  if (dimensionInitPromise) return dimensionInitPromise;
  dimensionInitPromise = (async () => {
    try {
      // 读取 system_settings 里的 embedding_dimension（更可靠：用户通过 UI 改的）
      const settingValue = await getSettingValue("embedding_dimension");
      let realDim: number;
      if (settingValue) {
        const parsed = parseInt(settingValue, 10);
        realDim = parsed > 0 ? parsed : env.zvecDimension;
      } else {
        // 兜底：尝试 loadEmbeddingConfig（会从 env/system_settings 综合读）
        try {
          const cfg = await loadEmbeddingConfig();
          realDim = cfg.dimension > 0 ? cfg.dimension : env.zvecDimension;
        } catch {
          realDim = env.zvecDimension;
        }
      }
      const currentDim = vectorEngineInstance.dimension ?? (vectorEngineInstance as unknown as { dim?: number }).dim;
      if (realDim === currentDim) {
        dimensionInitialized = true;
        return;
      }
      console.warn(`[VectorEngine] 维度不匹配: 当前 ${currentDim}, 真实 ${realDim}. 重建向量表...`);
      // drop 旧 vec0 虚拟表 + 元数据表（不同 dim 不能共存）
      const raw = getRawDb();
      raw.exec("DROP TABLE IF EXISTS vec_chunks");
      raw.exec("DROP TABLE IF EXISTS vec_chunk_meta");
      // 用真实 dim 重新初始化 engine（重置模块级单例，强制重建 schema）
      vectorEngineInstance = recreateVectorEngine(realDim);
      dimensionInitialized = true;
      console.log(`[VectorEngine] 已用 dim=${realDim} 重建向量表`);
    } catch (err) {
      console.error("[VectorEngine] ensureCorrectDimension 失败:", err instanceof Error ? err.message : String(err));
      // 失败时仍标记初始化完成，避免无限重试
      dimensionInitialized = true;
    }
  })();
  return dimensionInitPromise;
}

// ==================== M1: ZVec REST API 公共函数 ====================

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return embedWithFallback(texts);
}

export async function searchVectors(query: string, topK: number = 10): Promise<SearchResult[]> {
  // 启动前异步校准向量表维度（修复 R3 维度不匹配 bug）
  await ensureCorrectDimension();
  // 先把查询文本 embedding 成向量，再走向量检索。
  // R3 重构时 SqliteVecEngine.searchByText 移除了 embed 逻辑，
  // 这里在 service 层补回（与旧 zvec 行为一致）。
  const [queryVector] = await embedWithFallback([query]);
  if (!queryVector || queryVector.length === 0) return [];
  return vectorEngine.search(queryVector, topK);
}

export async function searchByVector(vector: number[], topK: number = 10): Promise<SearchResult[]> {
  return vectorEngine.search(vector, topK);
}

export async function listCollections(): Promise<VectorCollection[]> {
  const db = getDb();
  return db.select().from(vectorCollections).orderBy(desc(vectorCollections.updatedAt));
}

export interface CreateCollectionInput {
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly dimension?: number;
  readonly createdBy?: number | null;
}

export async function createCollection(input: CreateCollectionInput): Promise<{ id: number }> {
  const db = getDb();
  const result = await db.insert(vectorCollections).values({
    name: input.name,
    description: input.description ?? null,
    model: input.model ?? "text-embedding-3-small",
    dimension: input.dimension ?? 1536,
    createdBy: input.createdBy ?? null,
  });
  return { id: Number(result.lastInsertRowid) };
}

export async function deleteCollection(name: string): Promise<void> {
  const db = getDb();
  await db.delete(vectorCollections).where(eq(vectorCollections.name, name));
}

export interface AddDocumentInput {
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AddDocumentsResult {
  readonly added: number;
}

export interface CollectionStats {
  readonly name: string;
  readonly count: number;
  readonly dimension: number;
}

export async function addDocumentsToCollection(name: string, docs: AddDocumentInput[]): Promise<AddDocumentsResult> {
  const db = getDb();
  const [collection] = await db.select().from(vectorCollections).where(eq(vectorCollections.name, name));
  if (!collection) throw new Error(`Collection not found: ${name}`);
  const added = await vectorEngine.addDocuments(docs.map((doc) => ({ ...doc, metadata: { ...doc.metadata, collectionName: name } })));
  await db.update(vectorCollections).set({ documentCount: (collection.documentCount ?? 0) + added }).where(eq(vectorCollections.name, name));
  return { added };
}

export async function getCollectionStats(name: string): Promise<CollectionStats> {
  const db = getDb();
  const [collection] = await db.select().from(vectorCollections).where(eq(vectorCollections.name, name));
  if (!collection) throw new Error(`Collection not found: ${name}`);
  return { name: collection.name, count: collection.documentCount ?? 0, dimension: collection.dimension ?? 0 };
}

export async function getStats(): Promise<VectorHealthStatus> {
  const cfg = await loadEmbeddingConfig();
  const engineHealth = await vectorEngine.healthCheck();
  return {
    ...engineHealth,
    provider: cfg.enabled ? cfg.url : "hash-fallback",
    model: cfg.enabled ? cfg.model : "simple-hash-64",
    zvecEnabled: env.zvecEnabled,
    zvecDataDir: env.zvecDataDir,
    zvecDimension: env.zvecDimension,
    collectionName: "document_chunks",
  };
}
