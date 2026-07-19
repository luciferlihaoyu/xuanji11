/**
 * 璇玑向量引擎服务层 — Zvec 持久化优先，未配置时回退到内置余弦相似度
 */

// allow: SIZE_OK — 向量引擎是持有私有可变状态（collection / zvecInitialized / fallbackStore）的单体模块，
// 嵌入配置、请求、解析逻辑是 vectorEngine 的私有辅助函数；拆分会暴露内部状态并增加耦合。

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import zvec from "@zvec/zvec";
import type { ZVecCollection, ZVecCollectionSchema, ZVecDataType, ZVecDocInput, ZVecStatus } from "@zvec/zvec";
import { eq, desc } from "drizzle-orm";
import { systemSettings, vectorCollections, type VectorCollection } from "@db/schema";
import { env } from "./env";
import { getDb } from "../queries/connection";

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

const fallbackStore: VectorEntry[] = [];
const collectionName = "document_chunks";
const vectorFieldName = "embedding";
let zvecInitialized = false;
let collection: ZVecCollection | null = null;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

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
  const url = process.env.LLM_API_URL || "";
  const key = process.env.LLM_API_KEY || "";
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
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
  const url = settings.get("embedding_api_url") || process.env.LLM_API_URL || "";
  const key = settings.get("embedding_api_key") || process.env.LLM_API_KEY || "";
  const model = settings.get("embedding_model") || process.env.EMBEDDING_MODEL || "text-embedding-3-small";
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
    : rawText.slice(0, 200);
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

function normalizeVector(vector: number[]): number[] {
  if (vector.length === env.zvecDimension) return vector;
  if (vector.length > env.zvecDimension) return vector.slice(0, env.zvecDimension);
  return [...vector, ...new Array(env.zvecDimension - vector.length).fill(0)];
}

function scalarFields(metadata: Record<string, unknown>): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") fields[key] = value;
  }
  return fields;
}

function fieldType(value: string | number | boolean): ZVecDataType {
  if (typeof value === "boolean") return zvec.ZVecDataType.BOOL;
  if (typeof value === "number") return Number.isInteger(value) ? zvec.ZVecDataType.INT64 : zvec.ZVecDataType.DOUBLE;
  return zvec.ZVecDataType.STRING;
}

function assertStatus(status: ZVecStatus | ZVecStatus[]): void {
  const failed = Array.isArray(status) ? status.find((item) => !item.ok) : status.ok ? undefined : status;
  if (failed) throw new Error(`Zvec ${failed.code}: ${failed.message}`);
}

export function initializeZvec(): void {
  if (zvecInitialized || !env.zvecEnabled) return;
  zvec.ZVecInitialize({ logLevel: zvec.ZVecLogLevel.WARN });
  zvecInitialized = true;
}

function createSchema(): ZVecCollectionSchema {
  return new zvec.ZVecCollectionSchema({
    name: collectionName,
    vectors: { name: vectorFieldName, dataType: zvec.ZVecDataType.VECTOR_FP32, dimension: env.zvecDimension },
    fields: [
      { name: "documentId", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "chunkIndex", dataType: zvec.ZVecDataType.INT64 },
      { name: "content", dataType: zvec.ZVecDataType.STRING },
      { name: "title", dataType: zvec.ZVecDataType.STRING, nullable: true },
      { name: "type", dataType: zvec.ZVecDataType.STRING, nullable: true },
      { name: "itemId", dataType: zvec.ZVecDataType.STRING, nullable: true },
      { name: "format", dataType: zvec.ZVecDataType.STRING, nullable: true },
    ],
  });
}

function getCollection(): ZVecCollection {
  if (collection) return collection;
  initializeZvec();
  fs.mkdirSync(env.zvecDataDir, { recursive: true });
  collection = zvec.ZVecCreateAndOpen(path.join(env.zvecDataDir, collectionName), createSchema());
  return collection;
}

function ensureMetadataColumns(fields: Record<string, string | number | boolean>): void {
  const store = getCollection();
  for (const [name, value] of Object.entries(fields)) {
    try {
      store.schema.field(name);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      store.addColumnSync({ fieldSchema: { name, dataType: fieldType(value), nullable: true } });
    }
  }
}

function toZvecDoc(id: string, vector: number[], metadata: Record<string, unknown>): ZVecDocInput {
  const fields = scalarFields(metadata);
  ensureMetadataColumns(fields);
  return { id, vectors: { [vectorFieldName]: normalizeVector(vector) }, fields };
}

function documentFilter(documentId: number | string): string {
  return `documentId == '${String(documentId).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
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

function safeVectorSize(): { readonly size: number; readonly error?: string } {
  try {
    return { size: vectorEngine.size };
  } catch (err) {
    return { size: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export const vectorEngine = {
  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    if (!env.zvecEnabled) {
      fallbackStore.push({ id, vector: normalizeVector(vector), metadata });
      return;
    }
    assertStatus(getCollection().upsertSync(toZvecDoc(id, vector, metadata)));
  },

  async insertBatch(entries: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): Promise<void> {
    if (!env.zvecEnabled) {
      fallbackStore.push(...entries.map((entry) => ({ id: entry.id, vector: normalizeVector(entry.vector), metadata: entry.metadata ?? {} })));
      return;
    }
    assertStatus(getCollection().upsertSync(entries.map((entry) => toZvecDoc(entry.id, entry.vector, entry.metadata ?? {}))));
  },

  async indexDocumentChunks(documentId: number | string, chunks: Array<{ content: string; index: number; metadata?: Record<string, unknown> }>, baseMetadata: Record<string, unknown> = {}): Promise<number> {
    const docKey = String(documentId);
    await this.deleteByDocumentId(docKey);
    const embeddings = await embedWithFallback(chunks.map((c) => c.content));
    const entries = chunks.map((chunk, i) => ({
      id: `chunk-${docKey}-${chunk.index}`,
      vector: embeddings[i] ?? [],
      metadata: { ...baseMetadata, ...chunk.metadata, documentId: docKey, chunkIndex: chunk.index, content: chunk.content },
    }));
    await this.insertBatch(entries);
    return entries.length;
  },

  async deleteByDocumentId(documentId: number | string): Promise<number> {
    if (!env.zvecEnabled) {
      const before = fallbackStore.length;
      for (let i = fallbackStore.length - 1; i >= 0; i--) if (String(fallbackStore[i].metadata.documentId) === String(documentId)) fallbackStore.splice(i, 1);
      return before - fallbackStore.length;
    }
    const store = getCollection();
    const before = store.stats.docCount;
    assertStatus(store.deleteByFilterSync(documentFilter(documentId)));
    return before - store.stats.docCount;
  },

  async search(queryVector: number[], topK: number = 10): Promise<SearchResult[]> {
    const vector = normalizeVector(queryVector);
    if (!env.zvecEnabled) {
      return fallbackStore.map((entry) => ({ id: entry.id, score: cosineSimilarity(vector, entry.vector), metadata: entry.metadata })).sort((a, b) => b.score - a.score).slice(0, topK);
    }
    return getCollection().querySync({ fieldName: vectorFieldName, vector, topk: topK }).map((doc) => ({ id: doc.id, score: doc.score, metadata: doc.fields }));
  },

  async searchByText(query: string, topK: number = 10): Promise<SearchResult[]> {
    const [queryVector] = await embedWithFallback([query]);
    return this.search(queryVector ?? [], topK);
  },

  async embedText(text: string): Promise<number[]> {
    const [vector] = await embedWithFallback([text]);
    return normalizeVector(vector ?? []);
  },

  async addDocuments(docs: Array<{ content: string; metadata?: Record<string, unknown> }>): Promise<number> {
    if (docs.length === 0) return 0;
    const embeddings = await embedWithFallback(docs.map((doc) => doc.content));
    const entries = docs.map((doc, i) => ({
      id: randomUUID(),
      vector: embeddings[i] ?? [],
      metadata: { ...doc.metadata, content: doc.content },
    }));
    await this.insertBatch(entries);
    return entries.length;
  },

  get size(): number {
    return env.zvecEnabled ? getCollection().stats.docCount : fallbackStore.length;
  },

  clear(): void {
    if (!env.zvecEnabled) {
      fallbackStore.length = 0;
      return;
    }
    getCollection().destroySync();
    collection = null;
  },

  async healthCheck(): Promise<VectorHealthStatus> {
    const cfg = await loadEmbeddingConfig();
    const { size, error: sizeError } = safeVectorSize();
    const mode: "empty" | "indexed" = size === 0 ? "empty" : "indexed";
    const base = {
      engine: env.zvecEnabled ? "zvec" : cfg.enabled ? "embedding-api" : "cosine-fallback",
      size,
      mode,
      provider: cfg.enabled ? cfg.url : "hash-fallback",
      model: cfg.enabled ? cfg.model : "simple-hash-64",
      zvecEnabled: env.zvecEnabled,
      zvecDataDir: env.zvecDataDir,
      zvecDimension: env.zvecDimension,
      collectionName,
    };
    if (!cfg.enabled) return { ...base, ok: true };
    try {
      const [vector] = await fetchEmbeddingsWithConfig(["ping"], cfg);
      return { ...base, ok: true, dimension: vector?.length, error: sizeError };
    } catch (err) {
      const primaryError = err instanceof Error ? err.message : String(err);
      for (const fallback of await embeddingCandidates()) {
        if (fallback.templateId === cfg.templateId || (!fallback.templateId && fallback.url === cfg.url && fallback.model === cfg.model)) continue;
        try {
          const [vector] = await fetchEmbeddingsWithConfig(["ping"], fallback);
          return {
            ...base,
            ok: true,
            dimension: vector?.length,
            error: `Primary model failed: ${primaryError}`,
            fallbackTemplateId: fallback.templateId,
            fallbackTemplateName: fallback.templateName,
          };
        } catch (fallbackErr) {
          console.warn("[VectorEngine] Health fallback failed:", fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
        }
      }
      return { ...base, ok: false, error: sizeError ? `${sizeError}; ${primaryError}` : primaryError };
    }
  },
};

// ==================== M1: ZVec REST API 公共函数 ====================

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return embedWithFallback(texts);
}

export async function searchVectors(query: string, topK: number = 10): Promise<SearchResult[]> {
  return vectorEngine.searchByText(query, topK);
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
  return { id: Number(result[0].insertId) };
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
  return vectorEngine.healthCheck();
}
