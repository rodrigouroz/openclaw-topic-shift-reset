import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi, PluginHookMessageReceivedEvent } from "openclaw/plugin-sdk";
import {
  readJsonFileWithFallback,
  withFileLock,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk";

type PresetName = "conservative" | "balanced" | "aggressive";
type EmbeddingProvider = "auto" | "none" | "openai" | "ollama";
type HandoffMode = "none" | "summary" | "verbatim_last_n";
type HandoffPreference = "none" | "summary" | "verbatim";

type EmbeddingConfig = {
  provider?: EmbeddingProvider;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
};

type TopicShiftResetAdvancedConfig = {
  historyWindow?: number;
  minHistoryMessages?: number;
  minMeaningfulTokens?: number;
  minTokenLength?: number;
  minSignalChars?: number;
  minSignalTokenCount?: number;
  minSignalEntropy?: number;
  stripEnvelope?: boolean;
  softConsecutiveSignals?: number;
  cooldownMinutes?: number;
  ignoredProviders?: string[];
  softScoreThreshold?: number;
  hardScoreThreshold?: number;
  softSimilarityThreshold?: number;
  hardSimilarityThreshold?: number;
  softNoveltyThreshold?: number;
  hardNoveltyThreshold?: number;
  handoff?: HandoffPreference | HandoffMode;
  handoffLastN?: number;
  handoffMaxChars?: number;
  embeddings?: EmbeddingProvider;
  embedding?: EmbeddingConfig;
};

type TopicShiftResetConfig = {
  enabled?: boolean;
  preset?: PresetName;
  embeddings?: EmbeddingProvider;
  handoff?: HandoffPreference;
  dryRun?: boolean;
  debug?: boolean;
  advanced?: TopicShiftResetAdvancedConfig;

  // Legacy top-level aliases (kept for backward compatibility)
  historyWindow?: number;
  minHistoryMessages?: number;
  minMeaningfulTokens?: number;
  minTokenLength?: number;
  softConsecutiveSignals?: number;
  cooldownMinutes?: number;
  ignoredProviders?: string[];
  softScoreThreshold?: number;
  hardScoreThreshold?: number;
  softSimilarityThreshold?: number;
  hardSimilarityThreshold?: number;
  softNoveltyThreshold?: number;
  hardNoveltyThreshold?: number;
  handoffMode?: HandoffMode;
  handoffLastN?: number;
  handoffMaxChars?: number;
  embedding?: EmbeddingConfig;
};

type ResolvedConfig = {
  enabled: boolean;
  historyWindow: number;
  minHistoryMessages: number;
  minMeaningfulTokens: number;
  minTokenLength: number;
  minSignalChars: number;
  minSignalTokenCount: number;
  minSignalEntropy: number;
  stripEnvelope: boolean;
  softConsecutiveSignals: number;
  cooldownMinutes: number;
  ignoredProviders: Set<string>;
  softScoreThreshold: number;
  hardScoreThreshold: number;
  softSimilarityThreshold: number;
  hardSimilarityThreshold: number;
  softNoveltyThreshold: number;
  hardNoveltyThreshold: number;
  handoffMode: HandoffMode;
  handoffLastN: number;
  handoffMaxChars: number;
  embedding: {
    provider: EmbeddingProvider;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    timeoutMs: number;
  };
  dryRun: boolean;
  debug: boolean;
};

type SessionEntryLike = {
  sessionId?: string;
  updatedAt?: number;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  sessionFile?: string;
  [key: string]: unknown;
};

type HistoryEntry = {
  tokens: Set<string>;
  embedding?: number[];
  at: number;
};

type SessionState = {
  history: HistoryEntry[];
  pendingSoftSignals: number;
  pendingEntries: HistoryEntry[];
  lastResetAt?: number;
  lastSeenAt: number;
};

type ClassifierMetrics = {
  score: number;
  novelty: number;
  lexicalDistance: number;
  similarity?: number;
  usedEmbedding: boolean;
  pendingSoftSignals: number;
};

type ClassificationDecision =
  | { kind: "warmup" | "stable" | "suspect"; metrics: ClassifierMetrics; reason: string }
  | { kind: "rotate-hard" | "rotate-soft"; metrics: ClassifierMetrics; reason: string };

type EmbeddingBackend = {
  name: string;
  embed: (text: string) => Promise<number[] | null>;
};

type ResolvedFastSession = {
  sessionKey: string;
  routeKind: "direct" | "group" | "thread";
};

type TranscriptMessage = {
  role: string;
  text: string;
};

type PresetConfig = {
  historyWindow: number;
  minHistoryMessages: number;
  minMeaningfulTokens: number;
  minTokenLength: number;
  softConsecutiveSignals: number;
  cooldownMinutes: number;
  softScoreThreshold: number;
  hardScoreThreshold: number;
  softSimilarityThreshold: number;
  hardSimilarityThreshold: number;
  softNoveltyThreshold: number;
  hardNoveltyThreshold: number;
};

const PRESETS = {
  conservative: {
    historyWindow: 12,
    minHistoryMessages: 4,
    minMeaningfulTokens: 7,
    minTokenLength: 2,
    softConsecutiveSignals: 3,
    cooldownMinutes: 10,
    softScoreThreshold: 0.8,
    hardScoreThreshold: 0.92,
    softSimilarityThreshold: 0.3,
    hardSimilarityThreshold: 0.18,
    softNoveltyThreshold: 0.66,
    hardNoveltyThreshold: 0.8,
  },
  balanced: {
    historyWindow: 10,
    minHistoryMessages: 3,
    minMeaningfulTokens: 6,
    minTokenLength: 2,
    softConsecutiveSignals: 2,
    cooldownMinutes: 5,
    softScoreThreshold: 0.72,
    hardScoreThreshold: 0.86,
    softSimilarityThreshold: 0.36,
    hardSimilarityThreshold: 0.24,
    softNoveltyThreshold: 0.58,
    hardNoveltyThreshold: 0.74,
  },
  aggressive: {
    historyWindow: 8,
    minHistoryMessages: 2,
    minMeaningfulTokens: 5,
    minTokenLength: 2,
    softConsecutiveSignals: 1,
    cooldownMinutes: 2,
    softScoreThreshold: 0.64,
    hardScoreThreshold: 0.78,
    softSimilarityThreshold: 0.46,
    hardSimilarityThreshold: 0.34,
    softNoveltyThreshold: 0.48,
    hardNoveltyThreshold: 0.6,
  },
} satisfies Record<PresetName, PresetConfig>;

const DEFAULTS = {
  enabled: true,
  preset: "balanced" as PresetName,
  handoff: "summary" as HandoffPreference,
  handoffLastN: 6,
  handoffMaxChars: 220,
  embeddingProvider: "auto" as EmbeddingProvider,
  embeddingTimeoutMs: 7000,
  minSignalChars: 20,
  minSignalTokenCount: 3,
  minSignalEntropy: 1.2,
  stripEnvelope: true,
  dryRun: false,
  debug: false,
} as const;

const LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 1.35,
    minTimeout: 20,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 45_000,
} as const;

const MAX_TRACKED_SESSIONS = 10_000;
const STALE_SESSION_STATE_MS = 4 * 60 * 60 * 1000;
const MAX_RECENT_FAST_EVENTS = 20_000;
const FAST_EVENT_TTL_MS = 5 * 60 * 1000;
const ROTATION_DEDUPE_MS = 25_000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const n = Math.floor(value);
  if (n < min) {
    return min;
  }
  if (n > max) {
    return max;
  }
  return n;
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function pickDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizePreset(value: unknown): PresetName {
  if (typeof value !== "string") {
    return DEFAULTS.preset;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "conservative" || normalized === "balanced" || normalized === "aggressive") {
    return normalized;
  }
  return DEFAULTS.preset;
}

function normalizeEmbeddingProvider(value: unknown): EmbeddingProvider {
  if (typeof value !== "string") {
    return DEFAULTS.embeddingProvider;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "none" ||
    normalized === "openai" ||
    normalized === "ollama"
  ) {
    return normalized;
  }
  return DEFAULTS.embeddingProvider;
}

function normalizeHandoffPreference(value: unknown): HandoffPreference {
  if (typeof value !== "string") {
    return DEFAULTS.handoff;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "summary") {
    return normalized;
  }
  if (normalized === "verbatim" || normalized === "verbatim_last_n") {
    return "verbatim";
  }
  return DEFAULTS.handoff;
}

function resolveConfig(raw: unknown): ResolvedConfig {
  const obj = raw && typeof raw === "object" ? (raw as TopicShiftResetConfig) : {};
  const advanced =
    obj.advanced && typeof obj.advanced === "object"
      ? (obj.advanced as TopicShiftResetAdvancedConfig)
      : {};
  const legacyEmbedding =
    obj.embedding && typeof obj.embedding === "object"
      ? (obj.embedding as EmbeddingConfig)
      : {};
  const advancedEmbedding =
    advanced.embedding && typeof advanced.embedding === "object"
      ? (advanced.embedding as EmbeddingConfig)
      : {};

  const preset = normalizePreset(obj.preset);
  const presetConfig = PRESETS[preset];

  const ignoredProviders = new Set(
    Array.isArray(pickDefined(advanced.ignoredProviders, obj.ignoredProviders))
      ? (pickDefined(advanced.ignoredProviders, obj.ignoredProviders) as string[])
          .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
          .filter(Boolean)
      : [],
  );

  const handoffPreference = normalizeHandoffPreference(
    pickDefined(obj.handoff, advanced.handoff, obj.handoffMode),
  );
  const handoffMode: HandoffMode =
    handoffPreference === "verbatim" ? "verbatim_last_n" : handoffPreference;

  return {
    enabled: obj.enabled ?? DEFAULTS.enabled,
    historyWindow: clampInt(
      pickDefined(advanced.historyWindow, obj.historyWindow),
      presetConfig.historyWindow,
      2,
      40,
    ),
    minHistoryMessages: clampInt(
      pickDefined(advanced.minHistoryMessages, obj.minHistoryMessages),
      presetConfig.minHistoryMessages,
      1,
      30,
    ),
    minMeaningfulTokens: clampInt(
      pickDefined(advanced.minMeaningfulTokens, obj.minMeaningfulTokens),
      presetConfig.minMeaningfulTokens,
      2,
      60,
    ),
    minTokenLength: clampInt(
      pickDefined(advanced.minTokenLength, obj.minTokenLength),
      presetConfig.minTokenLength,
      1,
      8,
    ),
    minSignalChars: clampInt(
      advanced.minSignalChars,
      DEFAULTS.minSignalChars,
      1,
      500,
    ),
    minSignalTokenCount: clampInt(
      advanced.minSignalTokenCount,
      DEFAULTS.minSignalTokenCount,
      1,
      60,
    ),
    minSignalEntropy: clampFloat(
      advanced.minSignalEntropy,
      DEFAULTS.minSignalEntropy,
      0,
      8,
    ),
    stripEnvelope: advanced.stripEnvelope ?? DEFAULTS.stripEnvelope,
    softConsecutiveSignals: clampInt(
      pickDefined(advanced.softConsecutiveSignals, obj.softConsecutiveSignals),
      presetConfig.softConsecutiveSignals,
      1,
      4,
    ),
    cooldownMinutes: clampInt(
      pickDefined(advanced.cooldownMinutes, obj.cooldownMinutes),
      presetConfig.cooldownMinutes,
      0,
      240,
    ),
    ignoredProviders,
    softScoreThreshold: clampFloat(
      pickDefined(advanced.softScoreThreshold, obj.softScoreThreshold),
      presetConfig.softScoreThreshold,
      0,
      1,
    ),
    hardScoreThreshold: clampFloat(
      pickDefined(advanced.hardScoreThreshold, obj.hardScoreThreshold),
      presetConfig.hardScoreThreshold,
      0,
      1,
    ),
    softSimilarityThreshold: clampFloat(
      pickDefined(advanced.softSimilarityThreshold, obj.softSimilarityThreshold),
      presetConfig.softSimilarityThreshold,
      0,
      1,
    ),
    hardSimilarityThreshold: clampFloat(
      pickDefined(advanced.hardSimilarityThreshold, obj.hardSimilarityThreshold),
      presetConfig.hardSimilarityThreshold,
      0,
      1,
    ),
    softNoveltyThreshold: clampFloat(
      pickDefined(advanced.softNoveltyThreshold, obj.softNoveltyThreshold),
      presetConfig.softNoveltyThreshold,
      0,
      1,
    ),
    hardNoveltyThreshold: clampFloat(
      pickDefined(advanced.hardNoveltyThreshold, obj.hardNoveltyThreshold),
      presetConfig.hardNoveltyThreshold,
      0,
      1,
    ),
    handoffMode,
    handoffLastN: clampInt(
      pickDefined(advanced.handoffLastN, obj.handoffLastN),
      DEFAULTS.handoffLastN,
      1,
      20,
    ),
    handoffMaxChars: clampInt(
      pickDefined(advanced.handoffMaxChars, obj.handoffMaxChars),
      DEFAULTS.handoffMaxChars,
      60,
      800,
    ),
    embedding: {
      provider: normalizeEmbeddingProvider(
        pickDefined(
          obj.embeddings,
          advanced.embeddings,
          advancedEmbedding.provider,
          legacyEmbedding.provider,
        ),
      ),
      model: (() => {
        const rawModel = pickDefined(advancedEmbedding.model, legacyEmbedding.model);
        return typeof rawModel === "string" ? rawModel.trim() : undefined;
      })(),
      baseUrl: (() => {
        const rawBaseUrl = pickDefined(advancedEmbedding.baseUrl, legacyEmbedding.baseUrl);
        return typeof rawBaseUrl === "string" ? rawBaseUrl.trim() : undefined;
      })(),
      apiKey: (() => {
        const rawApiKey = pickDefined(advancedEmbedding.apiKey, legacyEmbedding.apiKey);
        return typeof rawApiKey === "string" ? rawApiKey.trim() : undefined;
      })(),
      timeoutMs: clampInt(
        pickDefined(advancedEmbedding.timeoutMs, legacyEmbedding.timeoutMs),
        DEFAULTS.embeddingTimeoutMs,
        1000,
        30_000,
      ),
    },
    dryRun: obj.dryRun ?? DEFAULTS.dryRun,
    debug: obj.debug ?? DEFAULTS.debug,
  };
}


function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16);
}

function normalizeTextForHash(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeList(text: string, minTokenLength: number): string[] {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ");
  const out: string[] = [];
  for (const token of normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []) {
    if (token.length < minTokenLength) {
      continue;
    }
    out.push(token);
  }
  return out;
}

function tokenize(text: string, minTokenLength: number): Set<string> {
  return new Set(tokenizeList(text, minTokenLength));
}

function tokenEntropy(tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const total = tokens.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function stripClassifierEnvelope(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let skipFence = false;
  let expectingMetadataFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (skipFence) {
      if (trimmed.startsWith("```")) {
        skipFence = false;
      }
      continue;
    }

    if (
      trimmed === "Conversation info (untrusted metadata):" ||
      trimmed === "Replied message (untrusted, for context):"
    ) {
      expectingMetadataFence = true;
      continue;
    }

    if (expectingMetadataFence && trimmed.startsWith("```")) {
      skipFence = true;
      expectingMetadataFence = false;
      continue;
    }

    expectingMetadataFence = false;

    if (
      trimmed.startsWith("System: [") ||
      trimmed.startsWith("Current time:") ||
      trimmed.startsWith("Read HEARTBEAT.md if it exists") ||
      trimmed.startsWith("To send an image back, prefer the message tool") ||
      trimmed.startsWith("[media attached:")
    ) {
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function unionTokens(entries: HistoryEntry[]): Set<string> {
  const combined = new Set<string>();
  for (const entry of entries) {
    for (const token of entry.tokens) {
      combined.add(token);
    }
  }
  return combined;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  const unionSize = left.size + right.size - overlap;
  if (unionSize <= 0) {
    return 0;
  }
  return overlap / unionSize;
}

function noveltyRatio(current: Set<string>, baseline: Set<string>): number {
  if (current.size === 0) {
    return 0;
  }
  let unseen = 0;
  for (const token of current) {
    if (!baseline.has(token)) {
      unseen += 1;
    }
  }
  return unseen / current.size;
}

function cosineSimilarity(a: number[], b: number[]): number | undefined {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return undefined;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return undefined;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function centroid(vectors: number[][]): number[] | undefined {
  if (vectors.length === 0) {
    return undefined;
  }
  const dim = vectors[0]?.length ?? 0;
  if (!dim) {
    return undefined;
  }
  for (const vector of vectors) {
    if (vector.length !== dim) {
      return undefined;
    }
  }
  const out = new Array<number>(dim).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dim; i += 1) {
      out[i] += vector[i];
    }
  }
  for (let i = 0; i < dim; i += 1) {
    out[i] /= vectors.length;
  }
  return out;
}

function trimHistory(entries: HistoryEntry[], limit: number): HistoryEntry[] {
  if (entries.length <= limit) {
    return entries;
  }
  return entries.slice(entries.length - limit);
}

function findStoreKey(store: Record<string, SessionEntryLike>, sessionKey: string): string | undefined {
  if (store[sessionKey]) {
    return sessionKey;
  }
  const normalized = sessionKey.toLowerCase();
  return Object.keys(store).find((key) => key.toLowerCase() === normalized);
}

function looksLikeGroup(value?: string): boolean {
  const candidate = (value ?? "").toLowerCase();
  if (!candidate) {
    return false;
  }
  return (
    candidate.includes(":group:") ||
    candidate.includes(":channel:") ||
    candidate.endsWith("@g.us") ||
    candidate.includes("thread")
  );
}

function inferFastPeer(event: PluginHookMessageReceivedEvent, ctx: { conversationId?: string }) {
  const from = event.from?.trim() ?? "";
  const conversationId = ctx.conversationId?.trim() || from;
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const threadIdRaw = metadata.threadId;
  const threadId =
    typeof threadIdRaw === "string"
      ? threadIdRaw.trim()
      : typeof threadIdRaw === "number"
        ? String(threadIdRaw)
        : "";

  if (threadId) {
    return {
      kind: "thread" as const,
      id: `${conversationId || from}:thread:${threadId}`,
    };
  }

  const kind = looksLikeGroup(conversationId) || looksLikeGroup(from) ? "group" : "direct";
  return {
    kind,
    id: conversationId || from || "unknown",
  };
}

function maybeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createOpenAiBackend(cfg: ResolvedConfig): EmbeddingBackend | null {
  const apiKey = cfg.embedding.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  const model = cfg.embedding.model || "text-embedding-3-small";
  const baseUrl = (cfg.embedding.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const endpoint = `${baseUrl}/embeddings`;

  return {
    name: `openai:${model}`,
    embed: async (text: string) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(cfg.embedding.timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`openai embeddings failed (${response.status}): ${body.slice(0, 240)}`);
      }
      const payload = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vector = payload.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error("openai embeddings returned empty vector");
      }
      return vector;
    },
  };
}

function createOllamaBackend(cfg: ResolvedConfig): EmbeddingBackend {
  const baseUrl = (cfg.embedding.baseUrl || process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = cfg.embedding.model || "nomic-embed-text";
  const endpoint = `${baseUrl}/api/embeddings`;

  return {
    name: `ollama:${model}`,
    embed: async (text: string) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(cfg.embedding.timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`ollama embeddings failed (${response.status}): ${body.slice(0, 240)}`);
      }
      const payload = (await response.json()) as { embedding?: number[] };
      if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) {
        throw new Error("ollama embeddings returned empty vector");
      }
      return payload.embedding;
    },
  };
}

function resolveEmbeddingBackend(cfg: ResolvedConfig): EmbeddingBackend | null {
  if (cfg.embedding.provider === "none") {
    return null;
  }
  if (cfg.embedding.provider === "openai") {
    return createOpenAiBackend(cfg);
  }
  if (cfg.embedding.provider === "ollama") {
    return createOllamaBackend(cfg);
  }

  const openai = createOpenAiBackend(cfg);
  if (openai) {
    return openai;
  }
  return createOllamaBackend(cfg);
}

function classifyMessage(params: {
  cfg: ResolvedConfig;
  state: SessionState;
  entry: HistoryEntry;
  now: number;
}): ClassificationDecision {
  const { cfg, state, entry, now } = params;
  const baselineEntries = state.history;
  const baselineTokens = unionTokens(baselineEntries);

  const lexicalSimilarity = jaccardSimilarity(entry.tokens, baselineTokens);
  const lexicalDistance = 1 - lexicalSimilarity;
  const novelty = noveltyRatio(entry.tokens, baselineTokens);

  const baseVectors = baselineEntries
    .map((item) => item.embedding)
    .filter((vector): vector is number[] => Array.isArray(vector) && vector.length > 0);
  const baseCentroid = centroid(baseVectors);
  const similarity =
    entry.embedding && baseCentroid ? cosineSimilarity(entry.embedding, baseCentroid) : undefined;
  const usedEmbedding = typeof similarity === "number";

  const score = usedEmbedding
    ? 0.7 * (1 - similarity) + 0.15 * lexicalDistance + 0.15 * novelty
    : 0.55 * lexicalDistance + 0.45 * novelty;

  const metrics = {
    score,
    novelty,
    lexicalDistance,
    similarity,
    usedEmbedding,
    pendingSoftSignals: state.pendingSoftSignals,
  } satisfies ClassifierMetrics;

  if (
    baselineEntries.length < cfg.minHistoryMessages ||
    baselineTokens.size < cfg.minMeaningfulTokens
  ) {
    return { kind: "warmup", metrics, reason: "warmup" };
  }

  const cooldownMs = cfg.cooldownMinutes * 60_000;
  const cooldownActive =
    cooldownMs > 0 && typeof state.lastResetAt === "number" && now - state.lastResetAt < cooldownMs;
  if (cooldownActive) {
    return { kind: "stable", metrics, reason: "cooldown" };
  }

  const hardSignal =
    score >= cfg.hardScoreThreshold ||
    ((typeof similarity === "number" ? similarity <= cfg.hardSimilarityThreshold : false) &&
      novelty >= cfg.hardNoveltyThreshold);

  if (hardSignal) {
    return { kind: "rotate-hard", metrics, reason: "hard-threshold" };
  }

  const softSignal =
    score >= cfg.softScoreThreshold ||
    ((typeof similarity === "number" ? similarity <= cfg.softSimilarityThreshold : false) &&
      novelty >= cfg.softNoveltyThreshold) ||
    (!usedEmbedding && novelty >= cfg.softNoveltyThreshold && lexicalDistance >= 0.45);

  if (!softSignal) {
    return { kind: "stable", metrics, reason: "stable" };
  }

  const nextPending = state.pendingSoftSignals + 1;
  if (nextPending >= cfg.softConsecutiveSignals) {
    return { kind: "rotate-soft", metrics, reason: "soft-confirmed" };
  }

  return { kind: "suspect", metrics, reason: "soft-suspect" };
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const text =
      typeof record.text === "string"
        ? record.text
        : typeof record.input_text === "string"
          ? record.input_text
          : "";
    if (text.trim()) {
      chunks.push(text.trim());
    }
  }
  return chunks.join("\n").trim();
}

function resolveSessionFilePathFromEntry(params: {
  storePath: string;
  entry?: SessionEntryLike;
}): string | null {
  const entry = params.entry;
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const sessionsDir = path.dirname(params.storePath);
  const sessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
  if (sessionFile) {
    return path.isAbsolute(sessionFile) ? sessionFile : path.resolve(sessionsDir, sessionFile);
  }
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
  if (!sessionId) {
    return null;
  }
  return path.resolve(sessionsDir, `${sessionId}.jsonl`);
}

async function readTranscriptTail(params: {
  sessionFile: string;
  takeLast: number;
}): Promise<TranscriptMessage[]> {
  const raw = await fs.readFile(params.sessionFile, "utf-8");
  const lines = raw.split("\n");
  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== "message") {
      continue;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractTextFromMessageContent(message.content);
    if (!text) {
      continue;
    }
    messages.push({ role, text });
  }

  if (messages.length <= params.takeLast) {
    return messages;
  }
  return messages.slice(messages.length - params.takeLast);
}

function truncateText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function formatHandoffEventText(params: {
  mode: HandoffMode;
  messages: TranscriptMessage[];
  maxChars: number;
}): string | null {
  if (params.mode === "none" || params.messages.length === 0) {
    return null;
  }

  const lines = params.messages.map((message) => {
    const role = message.role === "assistant" ? "assistant" : "user";
    return `${role}: ${truncateText(message.text, params.maxChars)}`;
  });

  const header =
    params.mode === "verbatim_last_n"
      ? "Topic-shift handoff (last messages from previous session):"
      : "Topic-shift handoff (compact context from previous session):";

  return `${header}\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

async function buildHandoffEventFromPreviousSession(params: {
  cfg: ResolvedConfig;
  storePath: string;
  previousEntry?: SessionEntryLike;
  logger: OpenClawPluginApi["logger"];
}): Promise<string | null> {
  if (params.cfg.handoffMode === "none") {
    return null;
  }
  const sessionFile = resolveSessionFilePathFromEntry({
    storePath: params.storePath,
    entry: params.previousEntry,
  });
  if (!sessionFile) {
    return null;
  }

  try {
    const tail = await readTranscriptTail({
      sessionFile,
      takeLast: params.cfg.handoffLastN,
    });
    return formatHandoffEventText({
      mode: params.cfg.handoffMode,
      messages: tail,
      maxChars: params.cfg.handoffMaxChars,
    });
  } catch (error) {
    params.logger.warn(
      `topic-shift-reset: handoff read failed file=${sessionFile} err=${String(error)}`,
    );
    return null;
  }
}

function pruneStateMaps(stateBySession: Map<string, SessionState>): void {
  const now = Date.now();
  for (const [sessionKey, state] of stateBySession) {
    if (now - state.lastSeenAt > STALE_SESSION_STATE_MS) {
      stateBySession.delete(sessionKey);
    }
  }
  if (stateBySession.size <= MAX_TRACKED_SESSIONS) {
    return;
  }
  const ordered = [...stateBySession.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  const toDrop = stateBySession.size - MAX_TRACKED_SESSIONS;
  for (let i = 0; i < toDrop; i += 1) {
    const sessionKey = ordered[i]?.[0];
    if (sessionKey) {
      stateBySession.delete(sessionKey);
    }
  }
}

function pruneRecentMap(map: Map<string, number>, ttlMs: number, maxSize: number): void {
  const now = Date.now();
  for (const [key, ts] of map) {
    if (now - ts > ttlMs) {
      map.delete(key);
    }
  }
  if (map.size <= maxSize) {
    return;
  }
  const ordered = [...map.entries()].sort((a, b) => a[1] - b[1]);
  const toDrop = map.size - maxSize;
  for (let i = 0; i < toDrop; i += 1) {
    const key = ordered[i]?.[0];
    if (key) {
      map.delete(key);
    }
  }
}

async function rotateSessionEntry(params: {
  api: OpenClawPluginApi;
  cfg: ResolvedConfig;
  sessionKey: string;
  agentId?: string;
  source: "fast" | "fallback";
  reason: string;
  metrics: ClassifierMetrics;
  entry: HistoryEntry;
  contentHash: string;
  state: SessionState;
}): Promise<boolean> {
  const storePath = params.api.runtime.channel.session.resolveStorePath(params.api.config.session?.store, {
    agentId: params.agentId,
  });

  if (params.cfg.dryRun) {
    params.state.lastResetAt = Date.now();
    params.state.pendingSoftSignals = 0;
    params.state.pendingEntries = [];
    params.state.history = trimHistory([params.entry], params.cfg.historyWindow);
    params.api.logger.info(
      [
        `topic-shift-reset: dry-run rotate`,
        `source=${params.source}`,
        `reason=${params.reason}`,
        `session=${params.sessionKey}`,
        `score=${params.metrics.score.toFixed(3)}`,
        `novelty=${params.metrics.novelty.toFixed(3)}`,
        `lex=${params.metrics.lexicalDistance.toFixed(3)}`,
        `sim=${typeof params.metrics.similarity === "number" ? params.metrics.similarity.toFixed(3) : "n/a"}`,
      ].join(" "),
    );
    return true;
  }

  let rotated = false;
  let previousEntry: SessionEntryLike | undefined;

  await withFileLock(storePath, LOCK_OPTIONS, async () => {
    const loaded = await readJsonFileWithFallback<Record<string, SessionEntryLike>>(storePath, {});
    const store = loaded.value;
    const storeKey = findStoreKey(store, params.sessionKey);
    if (!storeKey) {
      return;
    }
    const current = store[storeKey];
    if (!current || typeof current !== "object") {
      return;
    }

    previousEntry = { ...current };
    const next: SessionEntryLike = {
      ...current,
      sessionId: randomUUID(),
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    };
    delete next.sessionFile;

    store[storeKey] = next;
    await writeJsonFileAtomically(storePath, store);
    rotated = true;
  });

  if (!rotated) {
    params.api.logger.warn(`topic-shift-reset: rotate failed no-session-entry session=${params.sessionKey}`);
    return false;
  }

  const handoff = await buildHandoffEventFromPreviousSession({
    cfg: params.cfg,
    storePath,
    previousEntry,
    logger: params.api.logger,
  });
  if (handoff) {
    params.api.runtime.system.enqueueSystemEvent(handoff, {
      sessionKey: params.sessionKey,
      contextKey: `topic-shift-reset:${params.contentHash}`,
    });
  }

  params.state.lastResetAt = Date.now();
  params.state.pendingSoftSignals = 0;
  params.state.pendingEntries = [];
  params.state.history = trimHistory([params.entry], params.cfg.historyWindow);

  params.api.logger.warn(
    [
      `topic-shift-reset: rotated`,
      `source=${params.source}`,
      `reason=${params.reason}`,
      `session=${params.sessionKey}`,
      `score=${params.metrics.score.toFixed(3)}`,
      `novelty=${params.metrics.novelty.toFixed(3)}`,
      `lex=${params.metrics.lexicalDistance.toFixed(3)}`,
      `sim=${typeof params.metrics.similarity === "number" ? params.metrics.similarity.toFixed(3) : "n/a"}`,
      `handoff=${handoff ? "1" : "0"}`,
    ].join(" "),
  );

  return true;
}

export default function register(api: OpenClawPluginApi): void {
  const cfg = resolveConfig(api.pluginConfig);
  const sessionState = new Map<string, SessionState>();
  const recentFastEvents = new Map<string, number>();
  const recentRotationBySession = new Map<string, number>();

  let embeddingBackend: EmbeddingBackend | null = null;
  let embeddingInitError: string | null = null;
  try {
    embeddingBackend = resolveEmbeddingBackend(cfg);
  } catch (error) {
    embeddingInitError = String(error);
  }

  if (embeddingInitError) {
    api.logger.warn(`topic-shift-reset: embedding backend init failed: ${embeddingInitError}`);
  } else if (!embeddingBackend) {
    api.logger.warn("topic-shift-reset: embedding backend unavailable, using lexical-only mode");
  } else {
    api.logger.info(`topic-shift-reset: embedding backend ${embeddingBackend.name}`);
  }

  const classifyAndMaybeRotate = async (params: {
    source: "fast" | "fallback";
    sessionKey: string;
    text: string;
    messageProvider?: string;
    agentId?: string;
    dedupeKey?: string;
  }) => {
    if (!cfg.enabled) {
      return;
    }
    const sessionKey = params.sessionKey.trim();
    if (!sessionKey) {
      return;
    }

    const provider = params.messageProvider?.trim().toLowerCase();
    if (provider && cfg.ignoredProviders.has(provider)) {
      return;
    }

    const rawText = params.text.trim();
    const text = cfg.stripEnvelope ? stripClassifierEnvelope(rawText) : rawText;
    if (!text || text.startsWith("/")) {
      return;
    }

    const tokenList = tokenizeList(text, cfg.minTokenLength);
    const signalEntropy = tokenEntropy(tokenList);
    if (
      text.length < cfg.minSignalChars ||
      tokenList.length < cfg.minSignalTokenCount ||
      signalEntropy < cfg.minSignalEntropy
    ) {
      if (cfg.debug) {
        api.logger.info(
          [
            `topic-shift-reset: skip-low-signal`,
            `source=${params.source}`,
            `session=${sessionKey}`,
            `chars=${text.length}`,
            `tokens=${tokenList.length}`,
            `entropy=${signalEntropy.toFixed(3)}`,
          ].join(" "),
        );
      }
      return;
    }

    const tokens = new Set(tokenList);
    if (tokens.size < cfg.minMeaningfulTokens) {
      return;
    }

    const contentHash = hashString(normalizeTextForHash(text));
    const lastRotationAt = recentRotationBySession.get(`${sessionKey}:${contentHash}`);
    if (typeof lastRotationAt === "number" && Date.now() - lastRotationAt < ROTATION_DEDUPE_MS) {
      return;
    }

    let embedding: number[] | undefined;
    if (embeddingBackend) {
      try {
        const vector = await embeddingBackend.embed(text);
        if (Array.isArray(vector) && vector.length > 0) {
          embedding = vector;
        }
      } catch (error) {
        api.logger.warn(`topic-shift-reset: embeddings error backend=${embeddingBackend.name} err=${String(error)}`);
      }
    }

    const now = Date.now();
    const state =
      sessionState.get(sessionKey) ??
      ({
        history: [],
        pendingSoftSignals: 0,
        pendingEntries: [],
        lastResetAt: undefined,
        lastSeenAt: now,
      } satisfies SessionState);
    state.lastSeenAt = now;

    const entry: HistoryEntry = { tokens, embedding, at: now };
    const decision = classifyMessage({ cfg, state, entry, now });

    if (cfg.debug) {
      api.logger.info(
        [
          `topic-shift-reset: classify`,
          `source=${params.source}`,
          `kind=${decision.kind}`,
          `reason=${decision.reason}`,
          `session=${sessionKey}`,
          `score=${decision.metrics.score.toFixed(3)}`,
          `novelty=${decision.metrics.novelty.toFixed(3)}`,
          `lex=${decision.metrics.lexicalDistance.toFixed(3)}`,
          `sim=${typeof decision.metrics.similarity === "number" ? decision.metrics.similarity.toFixed(3) : "n/a"}`,
          `embed=${decision.metrics.usedEmbedding ? "1" : "0"}`,
          `pending=${state.pendingSoftSignals}`,
        ].join(" "),
      );
    }

    if (decision.kind === "warmup") {
      state.pendingSoftSignals = 0;
      state.pendingEntries = [];
      state.history = trimHistory([...state.history, entry], cfg.historyWindow);
      sessionState.set(sessionKey, state);
      pruneStateMaps(sessionState);
      return;
    }

    if (decision.kind === "stable") {
      const merged = [...state.history, ...state.pendingEntries, entry];
      state.pendingSoftSignals = 0;
      state.pendingEntries = [];
      state.history = trimHistory(merged, cfg.historyWindow);
      sessionState.set(sessionKey, state);
      pruneStateMaps(sessionState);
      return;
    }

    if (decision.kind === "suspect") {
      state.pendingSoftSignals += 1;
      state.pendingEntries = trimHistory([...state.pendingEntries, entry], cfg.softConsecutiveSignals);
      sessionState.set(sessionKey, state);
      pruneStateMaps(sessionState);
      return;
    }

    const rotated = await rotateSessionEntry({
      api,
      cfg,
      sessionKey,
      agentId: params.agentId,
      source: params.source,
      reason: decision.reason,
      metrics: {
        ...decision.metrics,
        pendingSoftSignals: state.pendingSoftSignals,
      },
      entry,
      contentHash,
      state,
    });

    if (rotated) {
      recentRotationBySession.set(`${sessionKey}:${contentHash}`, Date.now());
    }

    sessionState.set(sessionKey, state);
    pruneStateMaps(sessionState);
    pruneRecentMap(recentRotationBySession, ROTATION_DEDUPE_MS * 3, MAX_RECENT_FAST_EVENTS);
  };

  api.on("message_received", async (event, ctx) => {
    if (!cfg.enabled) {
      return;
    }
    const channelId = ctx.channelId?.trim();
    if (!channelId) {
      return;
    }

    const peer = inferFastPeer(event, { conversationId: ctx.conversationId });
    const text = event.content?.trim() ?? "";
    if (!text) {
      return;
    }

    const fastEventKey = [
      channelId,
      ctx.accountId ?? "",
      peer.kind,
      peer.id,
      hashString(normalizeTextForHash(text)),
    ].join("|");
    const seenAt = recentFastEvents.get(fastEventKey);
    if (typeof seenAt === "number" && Date.now() - seenAt < FAST_EVENT_TTL_MS) {
      return;
    }
    recentFastEvents.set(fastEventKey, Date.now());
    pruneRecentMap(recentFastEvents, FAST_EVENT_TTL_MS, MAX_RECENT_FAST_EVENTS);

    let resolved: ResolvedFastSession | null = null;
    try {
      const route = api.runtime.channel.routing.resolveAgentRoute({
        cfg: api.config,
        channel: channelId,
        accountId: ctx.accountId,
        peer,
      });
      resolved = {
        sessionKey: route.sessionKey,
        routeKind: peer.kind,
      };
    } catch (error) {
      if (cfg.debug) {
        api.logger.info(
          `topic-shift-reset: fast-route-skip channel=${channelId} peer=${maybeJson(peer)} err=${String(error)}`,
        );
      }
      return;
    }

    await classifyAndMaybeRotate({
      source: "fast",
      sessionKey: resolved.sessionKey,
      text,
      messageProvider: channelId,
      dedupeKey: fastEventKey,
    });
  });

  api.on("before_model_resolve", async (event, ctx) => {
    if (!cfg.enabled) {
      return;
    }
    const sessionKey = ctx.sessionKey?.trim();
    if (!sessionKey) {
      return;
    }

    await classifyAndMaybeRotate({
      source: "fallback",
      sessionKey,
      text: event.prompt,
      messageProvider: ctx.messageProvider,
      agentId: ctx.agentId,
    });
  });
}
