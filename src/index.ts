import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  readJsonFileWithFallback,
  withFileLock,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk";

type TopicShiftResetConfig = {
  enabled?: boolean;
  historyWindow?: number;
  minHistoryMessages?: number;
  minMeaningfulTokens?: number;
  similarityThreshold?: number;
  minNoveltyRatio?: number;
  consecutiveSignals?: number;
  cooldownMinutes?: number;
  ignoredProviders?: string[];
  dryRun?: boolean;
  debug?: boolean;
};

type ResolvedConfig = {
  enabled: boolean;
  historyWindow: number;
  minHistoryMessages: number;
  minMeaningfulTokens: number;
  similarityThreshold: number;
  minNoveltyRatio: number;
  consecutiveSignals: number;
  cooldownMinutes: number;
  ignoredProviders: Set<string>;
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

type SessionState = {
  history: Set<string>[];
  pendingSignals: number;
  lastResetAt?: number;
  lastSeenAt: number;
};

const DEFAULTS = {
  enabled: true,
  historyWindow: 8,
  minHistoryMessages: 3,
  minMeaningfulTokens: 6,
  similarityThreshold: 0.18,
  minNoveltyRatio: 0.72,
  consecutiveSignals: 2,
  cooldownMinutes: 5,
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

const STOP_WORDS = new Set<string>([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "for",
  "from",
  "get",
  "got",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "new",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "there",
  "they",
  "this",
  "to",
  "too",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

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

function resolveConfig(raw: unknown): ResolvedConfig {
  const obj = raw && typeof raw === "object" ? (raw as TopicShiftResetConfig) : {};
  const ignoredProviders = new Set(
    Array.isArray(obj.ignoredProviders)
      ? obj.ignoredProviders
          .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
          .filter(Boolean)
      : [],
  );
  return {
    enabled: obj.enabled ?? DEFAULTS.enabled,
    historyWindow: clampInt(obj.historyWindow, DEFAULTS.historyWindow, 2, 30),
    minHistoryMessages: clampInt(obj.minHistoryMessages, DEFAULTS.minHistoryMessages, 1, 20),
    minMeaningfulTokens: clampInt(
      obj.minMeaningfulTokens,
      DEFAULTS.minMeaningfulTokens,
      2,
      40,
    ),
    similarityThreshold: clampFloat(
      obj.similarityThreshold,
      DEFAULTS.similarityThreshold,
      0,
      1,
    ),
    minNoveltyRatio: clampFloat(obj.minNoveltyRatio, DEFAULTS.minNoveltyRatio, 0, 1),
    consecutiveSignals: clampInt(obj.consecutiveSignals, DEFAULTS.consecutiveSignals, 1, 4),
    cooldownMinutes: clampInt(obj.cooldownMinutes, DEFAULTS.cooldownMinutes, 0, 240),
    ignoredProviders,
    dryRun: obj.dryRun ?? DEFAULTS.dryRun,
    debug: obj.debug ?? DEFAULTS.debug,
  };
}

function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`~!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = normalized.split(" ");
  const output = new Set<string>();
  for (const token of tokens) {
    if (token.length < 3) {
      continue;
    }
    if (STOP_WORDS.has(token)) {
      continue;
    }
    if (/^\d+$/.test(token)) {
      continue;
    }
    output.add(token);
  }
  return output;
}

function unionHistory(history: Set<string>[]): Set<string> {
  const combined = new Set<string>();
  for (const entry of history) {
    for (const token of entry) {
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

function pushHistory(history: Set<string>[], tokens: Set<string>, limit: number): Set<string>[] {
  const next = [...history, tokens];
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function findStoreKey(store: Record<string, SessionEntryLike>, sessionKey: string): string | undefined {
  if (store[sessionKey]) {
    return sessionKey;
  }
  const normalized = sessionKey.toLowerCase();
  return Object.keys(store).find((key) => key.toLowerCase() === normalized);
}

async function rotateSessionEntry(params: {
  api: OpenClawPluginApi;
  sessionKey: string;
  agentId?: string;
}): Promise<boolean> {
  const storePath = params.api.runtime.channel.session.resolveStorePath(params.api.config.session?.store, {
    agentId: params.agentId,
  });
  let rotated = false;
  await withFileLock(storePath, LOCK_OPTIONS, async () => {
    const loaded = await readJsonFileWithFallback<Record<string, SessionEntryLike>>(storePath, {});
    const store = loaded.value;
    const key = findStoreKey(store, params.sessionKey);
    if (!key) {
      return;
    }
    const current = store[key];
    if (!current || typeof current !== "object") {
      return;
    }
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
    store[key] = next;
    await writeJsonFileAtomically(storePath, store);
    rotated = true;
  });
  return rotated;
}

function pruneSessionState(store: Map<string, SessionState>): void {
  const now = Date.now();
  for (const [sessionKey, state] of store) {
    if (now - state.lastSeenAt > STALE_SESSION_STATE_MS) {
      store.delete(sessionKey);
    }
  }
  if (store.size <= MAX_TRACKED_SESSIONS) {
    return;
  }
  const ordered = [...store.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  const toDrop = store.size - MAX_TRACKED_SESSIONS;
  for (let i = 0; i < toDrop; i += 1) {
    const sessionKey = ordered[i]?.[0];
    if (sessionKey) {
      store.delete(sessionKey);
    }
  }
}

export default function register(api: OpenClawPluginApi): void {
  const cfg = resolveConfig(api.pluginConfig);
  const sessionState = new Map<string, SessionState>();

  api.on("before_model_resolve", async (event, ctx) => {
    if (!cfg.enabled) {
      return;
    }
    const sessionKey = ctx.sessionKey?.trim();
    if (!sessionKey) {
      return;
    }
    const provider = ctx.messageProvider?.trim().toLowerCase();
    if (provider && cfg.ignoredProviders.has(provider)) {
      return;
    }

    const prompt = event.prompt.trim();
    if (!prompt || prompt.startsWith("/")) {
      return;
    }

    const tokens = tokenize(prompt);
    if (tokens.size < cfg.minMeaningfulTokens) {
      return;
    }

    const now = Date.now();
    const state = sessionState.get(sessionKey) ?? {
      history: [],
      pendingSignals: 0,
      lastResetAt: undefined,
      lastSeenAt: now,
    };
    state.lastSeenAt = now;

    const baseline = unionHistory(state.history);
    if (state.history.length < cfg.minHistoryMessages || baseline.size < cfg.minMeaningfulTokens) {
      state.pendingSignals = 0;
      state.history = pushHistory(state.history, tokens, cfg.historyWindow);
      sessionState.set(sessionKey, state);
      return;
    }

    const similarity = jaccardSimilarity(tokens, baseline);
    const novelty = noveltyRatio(tokens, baseline);
    const cooldownMs = cfg.cooldownMinutes * 60_000;
    const cooldownActive =
      cooldownMs > 0 &&
      typeof state.lastResetAt === "number" &&
      now - state.lastResetAt < cooldownMs;
    const isDrift =
      !cooldownActive &&
      similarity <= cfg.similarityThreshold &&
      novelty >= cfg.minNoveltyRatio;

    if (cfg.debug) {
      api.logger.info(
        [
          `topic-shift-reset: key=${sessionKey}`,
          `similarity=${similarity.toFixed(3)}`,
          `novelty=${novelty.toFixed(3)}`,
          `drift=${isDrift ? "1" : "0"}`,
          `pending=${state.pendingSignals}`,
        ].join(" "),
      );
    }

    if (!isDrift) {
      state.pendingSignals = 0;
      state.history = pushHistory(state.history, tokens, cfg.historyWindow);
      sessionState.set(sessionKey, state);
      pruneSessionState(sessionState);
      return;
    }

    state.pendingSignals += 1;
    sessionState.set(sessionKey, state);

    if (state.pendingSignals < cfg.consecutiveSignals) {
      pruneSessionState(sessionState);
      return;
    }

    state.pendingSignals = 0;

    if (cfg.dryRun) {
      api.logger.info(
        `topic-shift-reset: dry-run would rotate session for ${sessionKey} (similarity=${similarity.toFixed(3)}, novelty=${novelty.toFixed(3)})`,
      );
      state.lastResetAt = now;
      state.history = [tokens];
      sessionState.set(sessionKey, state);
      pruneSessionState(sessionState);
      return;
    }

    const rotated = await rotateSessionEntry({
      api,
      sessionKey,
      agentId: ctx.agentId,
    });
    if (!rotated) {
      api.logger.warn(`topic-shift-reset: no session store entry found for ${sessionKey}`);
      state.history = pushHistory(state.history, tokens, cfg.historyWindow);
      sessionState.set(sessionKey, state);
      pruneSessionState(sessionState);
      return;
    }

    state.lastResetAt = now;
    state.history = [tokens];
    sessionState.set(sessionKey, state);
    pruneSessionState(sessionState);
    api.logger.info(
      `topic-shift-reset: rotated session for ${sessionKey} (similarity=${similarity.toFixed(3)}, novelty=${novelty.toFixed(3)})`,
    );
  });
}
