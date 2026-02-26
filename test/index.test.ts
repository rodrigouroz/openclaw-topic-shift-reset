import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type JsonObject = Record<string, unknown>;

type SdkMockState = {
  writeCalls: Array<{ filePath: string; value: unknown }>;
  activeLocksByPath: Map<string, number>;
  maxLocksByPath: Map<string, number>;
  lockDelayMs: number;
};

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type TestApiBundle = {
  api: Record<string, unknown>;
  hooks: Map<string, HookHandler>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  resolveStorePath: ReturnType<typeof vi.fn>;
  enqueueSystemEvent: ReturnType<typeof vi.fn>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSdkMockState(lockDelayMs = 0): SdkMockState {
  return {
    writeCalls: [],
    activeLocksByPath: new Map(),
    maxLocksByPath: new Map(),
    lockDelayMs,
  };
}

function createSdkMockModule(state: SdkMockState) {
  return {
    readJsonFileWithFallback: async <T>(filePath: string, fallback: T) => {
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        try {
          const parsed = JSON.parse(raw) as T;
          return { value: parsed, exists: true };
        } catch {
          return { value: fallback, exists: true };
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT") {
          return { value: fallback, exists: false };
        }
        return { value: fallback, exists: false };
      }
    },
    writeJsonFileAtomically: async (filePath: string, value: unknown) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      state.writeCalls.push({ filePath: path.resolve(filePath), value });
    },
    withFileLock: async <T>(filePath: string, _opts: unknown, fn: () => Promise<T>) => {
      const resolved = path.resolve(filePath);
      const currentActive = (state.activeLocksByPath.get(resolved) ?? 0) + 1;
      state.activeLocksByPath.set(resolved, currentActive);
      const previousMax = state.maxLocksByPath.get(resolved) ?? 0;
      if (currentActive > previousMax) {
        state.maxLocksByPath.set(resolved, currentActive);
      }
      try {
        if (state.lockDelayMs > 0) {
          await sleep(state.lockDelayMs);
        }
        return await fn();
      } finally {
        const nextActive = (state.activeLocksByPath.get(resolved) ?? 1) - 1;
        state.activeLocksByPath.set(resolved, Math.max(0, nextActive));
      }
    },
  };
}

async function importRegisterWithSdkMock(state: SdkMockState): Promise<(api: unknown) => void> {
  vi.resetModules();
  vi.doMock("openclaw/plugin-sdk", () => createSdkMockModule(state), { virtual: true });
  const mod = await import("../src/index.ts");
  return mod.default as (api: unknown) => void;
}

function createTestApi(params: {
  pluginConfig?: JsonObject;
  stateDirResolver?: () => string;
  resolveStorePathImpl?: (store: unknown, opts: { agentId?: string }) => string;
  resolveRouteImpl?: (input: unknown) => { sessionKey: string; agentId?: string };
}): TestApiBundle {
  const hooks = new Map<string, HookHandler>();
  const logger = {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    debug: vi.fn<(message: string) => void>(),
  };
  const resolveStorePath = vi.fn(
    params.resolveStorePathImpl ??
      (() => {
        throw new Error("resolveStorePath not configured");
      }),
  );
  const enqueueSystemEvent = vi.fn<(text: string, opts: { sessionKey: string; contextKey?: string }) => void>();

  const api = {
    id: "openclaw-topic-shift-reset",
    name: "Topic Shift Reset",
    source: "test",
    pluginConfig: params.pluginConfig ?? { embedding: { provider: "none" } },
    config: {},
    runtime: {
      state: {
        resolveStateDir:
          params.stateDirResolver ??
          (() => {
            throw new Error("state dir unavailable");
          }),
      },
      channel: {
        session: {
          resolveStorePath,
        },
        routing: {
          resolveAgentRoute:
            params.resolveRouteImpl ??
            (() => ({ sessionKey: "agent:main:main", agentId: "main" })),
        },
      },
      system: {
        enqueueSystemEvent,
      },
    },
    logger,
    on: (hookName: string, handler: HookHandler) => {
      hooks.set(hookName, handler);
    },
  };

  return {
    api,
    hooks,
    logger,
    resolveStorePath,
    enqueueSystemEvent,
  };
}

function getHook<T extends HookHandler>(hooks: Map<string, HookHandler>, hookName: string): T {
  const handler = hooks.get(hookName);
  if (!handler) {
    throw new Error(`missing hook: ${hookName}`);
  }
  return handler as T;
}

async function emitUserMessage(
  hooks: Map<string, HookHandler>,
  params: {
    text: string;
    from?: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
  },
): Promise<void> {
  const messageReceived = getHook(hooks, "message_received");
  const from = params.from ?? "user-1";
  await messageReceived(
    { from, content: params.text },
    {
      channelId: params.channelId ?? "telegram",
      accountId: params.accountId ?? "default",
      conversationId: params.conversationId ?? from,
    },
  );
}

async function emitAgentMessage(
  hooks: Map<string, HookHandler>,
  params: {
    text: string;
    to?: string;
    success?: boolean;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
  },
): Promise<void> {
  const messageSent = getHook(hooks, "message_sent");
  const to = params.to ?? "user-1";
  await messageSent(
    {
      to,
      content: params.text,
      success: params.success ?? true,
    },
    {
      channelId: params.channelId ?? "telegram",
      accountId: params.accountId ?? "default",
      conversationId: params.conversationId ?? to,
    },
  );
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("openclaw-topic-shift-reset", () => {
  it("persists runtime state and restores it after restart", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-state-"));
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const persistencePath = path.join(
      stateDir,
      "plugins",
      "openclaw-topic-shift-reset",
      "runtime-state.v1.json",
    );
    const sdkState1 = createSdkMockState();
    const register1 = await importRegisterWithSdkMock(sdkState1);

    const apiBundle1 = createTestApi({
      stateDirResolver: () => stateDir,
      resolveStorePathImpl: () => storePath,
    });
    register1(apiBundle1.api);

    const gatewayStop1 = getHook(apiBundle1.hooks, "gateway_stop");

    await emitUserMessage(apiBundle1.hooks, {
      text: "This is a baseline message with enough signal tokens for warmup.",
      conversationId: "user-1",
    });
    await gatewayStop1({ reason: "test" }, {});

    const persisted = (await readJson(persistencePath)) as {
      version?: number;
      sessionStateBySessionKey?: Record<string, unknown>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.sessionStateBySessionKey?.[sessionKey]).toBeTruthy();

    const sdkState2 = createSdkMockState();
    const register2 = await importRegisterWithSdkMock(sdkState2);
    const apiBundle2 = createTestApi({
      stateDirResolver: () => stateDir,
      resolveStorePathImpl: () => storePath,
    });
    register2(apiBundle2.api);

    await emitUserMessage(apiBundle2.hooks, {
      text: "Follow-up message to force state load before classification.",
      conversationId: "user-1",
    });

    expect(
      apiBundle2.logger.info.mock.calls.some(([message]) =>
        String(message).includes("topic-shift-reset: restored state sessions="),
      ),
    ).toBe(true);
  });

  it("uses routed agentId on inbound user rotation so multi-agent stores rotate correctly", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-routing-"));
    const mainStorePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const alphaStorePath = path.join(rootDir, "agents", "alpha", "sessions", "sessions.json");
    const routedSessionKey = "agent:alpha:telegram:default:direct:user-1";
    await fs.mkdir(path.dirname(alphaStorePath), { recursive: true });
    await fs.writeFile(
      alphaStorePath,
      JSON.stringify(
        {
          [routedSessionKey]: {
            sessionId: "alpha-session-initial",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 1,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: (_store, opts) => (opts.agentId === "alpha" ? alphaStorePath : mainStorePath),
      resolveRouteImpl: () => ({
        sessionKey: routedSessionKey,
        agentId: "alpha",
      }),
    });
    register(apiBundle.api);

    const messageReceived = getHook(apiBundle.hooks, "message_received");
    await messageReceived(
      { from: "user-1", content: "baseline topic message one" },
      { channelId: "telegram", accountId: "default", conversationId: "user-1" },
    );
    await messageReceived(
      { from: "user-1", content: "new shifted topic message two" },
      { channelId: "telegram", accountId: "default", conversationId: "user-1" },
    );

    const alphaStore = (await readJson(alphaStorePath)) as Record<string, { sessionId?: string }>;
    expect(alphaStore[routedSessionKey]?.sessionId).toBeTruthy();
    expect(alphaStore[routedSessionKey]?.sessionId).not.toBe("alpha-session-initial");
    expect(apiBundle.resolveStorePath.mock.calls.some(([, opts]) => opts?.agentId === "alpha")).toBe(true);
  });

  it("serializes same-session processing to prevent concurrent duplicate rotates", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-concurrency-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "main-initial-session",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState(25);
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 1,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: () => storePath,
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "baseline warmup event",
      conversationId: "user-1",
    });

    await Promise.all([
      emitUserMessage(apiBundle.hooks, {
        text: "concurrent rotate candidate one",
        conversationId: "user-1",
      }),
      emitUserMessage(apiBundle.hooks, {
        text: "concurrent rotate candidate two",
        conversationId: "user-1",
      }),
    ]);

    const storeWrites = sdkState.writeCalls.filter((call) => call.filePath === path.resolve(storePath));
    expect(storeWrites).toHaveLength(1);
    expect(sdkState.maxLocksByPath.get(path.resolve(storePath)) ?? 0).toBeLessThanOrEqual(1);
  });

  it("archives prior transcript with reset suffix when rotating a session", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-archive-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const initialSessionId = "main-initial-session";
    const sessionsDir = path.dirname(storePath);
    const priorTranscriptPath = path.join(sessionsDir, `${initialSessionId}.jsonl`);
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: initialSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      priorTranscriptPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "input_text", text: "baseline transcript line" }] },
      })}\n`,
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 1,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: () => storePath,
      resolveRouteImpl: () => ({
        sessionKey,
        agentId: "main",
      }),
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "baseline warmup event",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "new shifted topic message two",
      conversationId: "user-1",
    });

    const store = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
    expect(store[sessionKey]?.sessionId).toBeTruthy();
    expect(store[sessionKey]?.sessionId).not.toBe(initialSessionId);

    await expect(fs.stat(priorTranscriptPath)).rejects.toMatchObject({ code: "ENOENT" });
    const archived = (await fs.readdir(sessionsDir)).find((name) =>
      name.startsWith(`${initialSessionId}.jsonl.reset.`),
    );
    expect(archived).toBeTruthy();
  });

  it("recovers legacy orphan transcripts into session store entries once per store", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-recover-orphans-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionsDir = path.dirname(storePath);
    const sessionKey = "agent:main:main";
    const activeSessionId = "active-session";
    const orphanSessionId = "legacy-orphan-session";
    const orphanTranscriptPath = path.join(sessionsDir, `${orphanSessionId}.jsonl`);
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: activeSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      orphanTranscriptPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "input_text", text: "legacy orphan transcript line" }] },
      })}\n`,
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
      },
      resolveStorePathImpl: () => storePath,
      resolveRouteImpl: () => ({
        sessionKey,
        agentId: "main",
      }),
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "trigger orphan recovery",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "trigger orphan recovery second message",
      conversationId: "user-1",
    });

    const store = (await readJson(storePath)) as Record<
      string,
      { sessionId?: string; sessionFile?: string; updatedAt?: number }
    >;
    const recoveredEntry = Object.entries(store).find(([, entry]) => entry?.sessionId === orphanSessionId);
    expect(recoveredEntry).toBeTruthy();
    expect(recoveredEntry?.[0].startsWith("agent:main:recovered:")).toBe(true);
    expect(recoveredEntry?.[1].sessionFile).toBe(`${orphanSessionId}.jsonl`);
    expect(typeof recoveredEntry?.[1].updatedAt).toBe("number");

    const recoveryLogs = apiBundle.logger.info.mock.calls.filter(([message]) =>
      String(message).includes("topic-shift-reset: orphan-recovery recovered="),
    );
    expect(recoveryLogs).toHaveLength(1);
  });

  it("downgrades lexical hard signals to suspect when similarity is unavailable", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-no-sim-hard-downgrade-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const initialSessionId = "main-initial-session";
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: initialSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        debug: true,
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 2,
          softScoreThreshold: 1,
          softNoveltyThreshold: 1,
          hardScoreThreshold: 0,
          hardNoveltyThreshold: 0,
        },
      },
      resolveStorePathImpl: () => storePath,
      resolveRouteImpl: () => ({
        sessionKey,
        agentId: "main",
      }),
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "baseline lexical context",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "totally different lexical topic trigger",
      conversationId: "user-1",
    });

    const store = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
    expect(store[sessionKey]?.sessionId).toBe(initialSessionId);
    expect(
      apiBundle.logger.info.mock.calls.some(([message]) =>
        String(message).includes("topic-shift-reset: rotated"),
      ),
    ).toBe(false);
    expect(
      apiBundle.logger.debug.mock.calls.some(([message]) => {
        const line = String(message);
        return line.includes("topic-shift-reset: classify") && line.includes("kind=suspect");
      }),
    ).toBe(true);
  });

  it("routes hard similarity spikes through soft confirmation when embeddings are available", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-hard-sim-soft-path-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const initialSessionId = "main-initial-session";
    const persistencePath = path.join(
      rootDir,
      "plugins",
      "openclaw-topic-shift-reset",
      "runtime-state.v1.json",
    );
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.mkdir(path.dirname(persistencePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: initialSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      persistencePath,
      JSON.stringify(
        {
          version: 1,
          savedAt: Date.now(),
          sessionStateBySessionKey: {
            [sessionKey]: {
              history: [{ tokens: ["baseline", "topic"], at: Date.now() - 1000 }],
              pendingSoftSignals: 0,
              pendingEntries: [],
              topicCentroid: [1, 0],
              topicCount: 1,
              topicDim: 2,
              lastSeenAt: Date.now(),
            },
          },
          recentRotationBySession: {},
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => rootDir,
      pluginConfig: {
        embedding: {
          provider: "openai",
          apiKey: "test-key",
          baseUrl: "https://embeddings.example.test/v1",
          timeoutMs: 2000,
        },
        softSuspect: {
          action: "none",
        },
        debug: true,
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 2,
          softScoreThreshold: 1,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 0,
          softSimilarityThreshold: 0.3,
          hardSimilarityThreshold: 0.3,
        },
      },
      resolveStorePathImpl: () => storePath,
      resolveRouteImpl: () => ({
        sessionKey,
        agentId: "main",
      }),
    });
    register(apiBundle.api);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bodyRaw = typeof init?.body === "string" ? init.body : "{}";
        const body = JSON.parse(bodyRaw) as { input?: string };
        const inputText = String(body.input ?? "");
        const vector = inputText.includes("shift") ? [0, 1] : [1, 0];
        return new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

    try {
      await emitUserMessage(apiBundle.hooks, {
        text: "first shift candidate different topic",
        conversationId: "user-1",
      });

      const storeAfterFirst = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
      expect(storeAfterFirst[sessionKey]?.sessionId).toBe(initialSessionId);
      expect(
        apiBundle.logger.info.mock.calls.some(([message]) =>
          String(message).includes("topic-shift-reset: rotated"),
        ),
      ).toBe(false);

      await emitUserMessage(apiBundle.hooks, {
        text: "second shift candidate different topic",
        conversationId: "user-1",
      });

      const storeAfterSecond = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
      expect(storeAfterSecond[sessionKey]?.sessionId).toBeTruthy();
      expect(storeAfterSecond[sessionKey]?.sessionId).not.toBe(initialSessionId);
      expect(
        apiBundle.logger.info.mock.calls.some(([message]) => {
          const line = String(message);
          return line.includes("topic-shift-reset: rotated") && line.includes("reason=soft-confirmed");
        }),
      ).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps pending soft-suspect context after a soft-confirm rotation", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-soft-history-seed-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const persistencePath = path.join(
      rootDir,
      "plugins",
      "openclaw-topic-shift-reset",
      "runtime-state.v1.json",
    );
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "main-initial-session",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => rootDir,
      pluginConfig: {
        embedding: { provider: "none" },
        softSuspect: { action: "none" },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 2,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: () => storePath,
      resolveRouteImpl: () => ({
        sessionKey,
        agentId: "main",
      }),
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "baseline message alpha",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "firstcandidate shift context foo",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "secondcandidate shift context bar",
      conversationId: "user-1",
    });

    const gatewayStop = getHook(apiBundle.hooks, "gateway_stop");
    await gatewayStop({ reason: "test" }, {});

    const persisted = (await readJson(persistencePath)) as {
      sessionStateBySessionKey?: Record<
        string,
        {
          history?: Array<{ tokens?: string[] }>;
          pendingEntries?: unknown[];
        }
      >;
    };
    const sessionState = persisted.sessionStateBySessionKey?.[sessionKey];
    expect(sessionState).toBeTruthy();
    expect(sessionState?.history?.length).toBe(2);
    const flattenedTokens = (sessionState?.history ?? []).flatMap((entry) => entry.tokens ?? []);
    expect(flattenedTokens).toContain("firstcandidate");
    expect(flattenedTokens).toContain("secondcandidate");
    expect(sessionState?.pendingEntries ?? []).toHaveLength(0);
  });

  it("does not register before_model_resolve fallback classification hook", async () => {
    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      resolveStorePathImpl: () => path.join(os.tmpdir(), "topic-shift-reset-unused-store.json"),
    });
    register(apiBundle.api);

    expect(apiBundle.hooks.has("before_model_resolve")).toBe(false);
    expect(apiBundle.hooks.has("message_received")).toBe(true);
    expect(apiBundle.hooks.has("message_sent")).toBe(true);
  });

  it("includes message preview fields in classify debug logs", async () => {
    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        debug: true,
      },
      resolveStorePathImpl: () => path.join(os.tmpdir(), "topic-shift-reset-unused-store.json"),
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "Problem in node 'Scan Markets' after nightly sync. Please inspect parser mismatch.",
      conversationId: "user-1",
    });

    const classifyLog = apiBundle.logger.debug.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("topic-shift-reset: classify"));

    expect(classifyLog).toBeTruthy();
    expect(classifyLog).toContain("textHash=");
    expect(classifyLog).toContain("tokens=");
    expect(classifyLog).toContain("text=");
    expect((classifyLog ?? "").toLowerCase()).toContain("scan markets");
  });

  it("uses outbound agent text only for context updates and skips failed sends", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-double-count-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const initialSessionId = "main-initial-session";
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: initialSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 2,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: () => storePath,
      resolveRouteImpl: () => ({
        sessionKey,
        agentId: "main",
      }),
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "alpha beta gamma",
      conversationId: "user-1",
    });
    await emitAgentMessage(apiBundle.hooks, {
      text: "agent response that should not trigger rotation",
      to: "user-1",
      success: false,
      conversationId: "user-1",
    });
    await emitAgentMessage(apiBundle.hooks, {
      text: "agent response that should not trigger rotation",
      to: "user-1",
      success: true,
      conversationId: "user-1",
    });

    const store = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
    expect(store[sessionKey]?.sessionId).toBeTruthy();
    expect(store[sessionKey]?.sessionId).toBe(initialSessionId);
  });

  it("ignores incompatible persisted state versions safely", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-version-"));
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const persistencePath = path.join(
      stateDir,
      "plugins",
      "openclaw-topic-shift-reset",
      "runtime-state.v1.json",
    );
    await fs.mkdir(path.dirname(persistencePath), { recursive: true });
    await fs.writeFile(
      persistencePath,
      JSON.stringify(
        {
          version: 999,
          savedAt: Date.now(),
          sessionStateBySessionKey: {
            "agent:main:main": {
              history: [],
              pendingSoftSignals: 0,
              pendingEntries: [],
              topicCount: 0,
              lastSeenAt: Date.now(),
            },
          },
          recentRotationBySession: {},
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => stateDir,
      resolveStorePathImpl: () => storePath,
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "message to wait for persistence-load completion",
      conversationId: "user-1",
    });

    expect(
      apiBundle.logger.warn.mock.calls.some(([message]) =>
        String(message).includes("topic-shift-reset: state version mismatch"),
      ),
    ).toBe(true);
  });

  it("injects a one-shot clarification steer on soft-suspect via before_prompt_build", async () => {
    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const sessionKey = "agent:main:main";
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        softSuspect: {
          action: "ask",
          mode: "strict",
          prompt: "ASK_CLARIFY_ON_TOPIC_SHIFT",
          ttlSeconds: 120,
        },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 2,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: () => path.join(os.tmpdir(), "topic-shift-reset-unused-store.json"),
    });
    register(apiBundle.api);

    const beforePromptBuild = getHook(apiBundle.hooks, "before_prompt_build");

    await emitUserMessage(apiBundle.hooks, {
      text: "alpha beta gamma",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "alpha fresh topic with very different terms",
      conversationId: "user-1",
    });

    const steer = await beforePromptBuild(
      { prompt: "alpha fresh topic with very different terms", messages: [] },
      { sessionKey, messageProvider: "telegram", agentId: "main" },
    );
    expect(steer).toEqual({ prependContext: "ASK_CLARIFY_ON_TOPIC_SHIFT" });

    const secondAttempt = await beforePromptBuild(
      { prompt: "alpha fresh topic with very different terms", messages: [] },
      { sessionKey, messageProvider: "telegram", agentId: "main" },
    );
    expect(secondAttempt).toBeUndefined();
  });

  it("does not inject clarification steer when softSuspect action is none", async () => {
    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const sessionKey = "agent:main:main";
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        softSuspect: {
          action: "none",
          prompt: "SHOULD_NOT_APPEAR",
          ttlSeconds: 120,
        },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 2,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: () => path.join(os.tmpdir(), "topic-shift-reset-unused-store.json"),
    });
    register(apiBundle.api);

    const beforePromptBuild = getHook(apiBundle.hooks, "before_prompt_build");

    await emitUserMessage(apiBundle.hooks, {
      text: "alpha beta gamma",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "alpha fresh topic with very different terms",
      conversationId: "user-1",
    });

    const steer = await beforePromptBuild(
      { prompt: "alpha fresh topic with very different terms", messages: [] },
      { sessionKey, messageProvider: "telegram", agentId: "main" },
    );
    expect(steer).toBeUndefined();
  });

  it("strict softSuspect blocks soft-confirm until ask is injected and user replies", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-softsuspect-strict-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const initialSessionId = "main-initial-session";
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: initialSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        softSuspect: {
          action: "ask",
          mode: "strict",
          prompt: "ASK_CLARIFY_STRICT",
          ttlSeconds: 120,
        },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 2,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: () => storePath,
      resolveRouteImpl: () => ({
        sessionKey,
        agentId: "main",
      }),
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "scan markets node baseline context",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "scan markets node refresh issue now",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "scan markets node still failing after retry",
      conversationId: "user-1",
    });

    const storeAfterBlocked = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
    expect(storeAfterBlocked[sessionKey]?.sessionId).toBe(initialSessionId);

    const beforePromptBuild = getHook(apiBundle.hooks, "before_prompt_build");
    const steer = await beforePromptBuild(
      { prompt: "prompt placeholder", messages: [] },
      { sessionKey, messageProvider: "telegram", agentId: "main" },
    );
    expect(steer).toEqual({ prependContext: "ASK_CLARIFY_STRICT" });

    const secondSteer = await beforePromptBuild(
      { prompt: "prompt placeholder", messages: [] },
      { sessionKey, messageProvider: "telegram", agentId: "main" },
    );
    expect(secondSteer).toBeUndefined();

    await emitUserMessage(apiBundle.hooks, {
      text: "user reply after clarification prompt",
      conversationId: "user-1",
    });

    const storeAfterReply = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
    expect(storeAfterReply[sessionKey]?.sessionId).toBeTruthy();
    expect(storeAfterReply[sessionKey]?.sessionId).not.toBe(initialSessionId);
  });

  it("best_effort softSuspect can soft-confirm before ask injection", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-softsuspect-best-effort-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const initialSessionId = "main-initial-session";
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: initialSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        softSuspect: {
          action: "ask",
          mode: "best_effort",
          prompt: "ASK_CLARIFY_BEST_EFFORT",
          ttlSeconds: 120,
        },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          softConsecutiveSignals: 2,
          softScoreThreshold: 0,
          softNoveltyThreshold: 0,
          hardScoreThreshold: 1,
          hardNoveltyThreshold: 1,
        },
      },
      resolveStorePathImpl: () => storePath,
      resolveRouteImpl: () => ({
        sessionKey,
        agentId: "main",
      }),
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "scan markets node baseline context",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "scan markets node refresh issue now",
      conversationId: "user-1",
    });
    await emitUserMessage(apiBundle.hooks, {
      text: "scan markets node still failing after retry",
      conversationId: "user-1",
    });

    const store = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
    expect(store[sessionKey]?.sessionId).toBeTruthy();
    expect(store[sessionKey]?.sessionId).not.toBe(initialSessionId);

    const beforePromptBuild = getHook(apiBundle.hooks, "before_prompt_build");
    const steer = await beforePromptBuild(
      { prompt: "prompt placeholder", messages: [] },
      { sessionKey, messageProvider: "telegram", agentId: "main" },
    );
    expect(steer).toBeUndefined();
  });

  it("ignores internal cron/heartbeat provider turns for user message classification", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-shift-reset-internal-provider-"));
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "main-initial-session",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sdkState = createSdkMockState();
    const register = await importRegisterWithSdkMock(sdkState);
    const apiBundle = createTestApi({
      stateDirResolver: () => {
        throw new Error("disable persistence for this test");
      },
      pluginConfig: {
        embedding: { provider: "none" },
        advanced: {
          minHistoryMessages: 1,
          minMeaningfulTokens: 1,
          minSignalChars: 1,
          minSignalTokenCount: 1,
          hardScoreThreshold: 0,
          hardNoveltyThreshold: 0,
        },
      },
      resolveStorePathImpl: () => storePath,
    });
    register(apiBundle.api);

    await emitUserMessage(apiBundle.hooks, {
      text: "cron reminder event text that should not rotate sessions",
      channelId: "cron-event",
      conversationId: "user-1",
    });

    const store = (await readJson(storePath)) as Record<string, { sessionId?: string }>;
    expect(store[sessionKey]?.sessionId).toBe("main-initial-session");
  });
});
