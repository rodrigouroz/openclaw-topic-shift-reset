# openclaw-topic-shift-reset

OpenClaw plugin that detects topic shifts and rotates to a fresh session automatically.

Classifier input sources: inbound user message text (`message_received`) and successful outbound agent message text (`message_sent`) only. It does not classify `before_model_resolve` prompt wrappers.

## Why this plugin exists

OpenClaw builds each model call with the current prompt plus session history. As one session accumulates mixed topics, prompts get larger, token usage grows, and context-overflow/compaction pressure increases.

This plugin tries to prevent that by detecting topic shifts and rotating to a new session key when confidence is high. In practice, that keeps subsequent turns focused on the new topic, which usually means:

- fewer prompt tokens per turn after a shift
- less stale context bleeding into new questions
- lower chance of overflow/compaction churn on long chats
- classifier state persisted across gateway restarts (no cold start after reboot)

Does it deliver? Yes for clear topic changes, especially with embeddings enabled and sane defaults. It is not a core patch, so behavior is best-effort: subtle/short messages can be ambiguous, and hook timing means the triggering turn cannot be guaranteed to become the very first persisted message of the new session in every path.

## Install

```bash
openclaw plugins install openclaw-topic-shift-reset
openclaw plugins enable openclaw-topic-shift-reset
openclaw plugins info openclaw-topic-shift-reset
```

Add this plugin entry in `~/.openclaw/openclaw.json` (or merge into your existing config):

```json
{
  "plugins": {
    "allow": ["openclaw-topic-shift-reset"],
    "entries": {
      "openclaw-topic-shift-reset": {
        "enabled": true,
        "config": {
          "preset": "balanced",
          "embedding": {
            "provider": "auto",
            "timeoutMs": 7000
          },
          "handoff": {
            "mode": "summary",
            "lastN": 6,
            "maxChars": 220
          },
          "softSuspect": {
            "action": "ask",
            "mode": "strict",
            "ttlSeconds": 120
          },
          "dryRun": false,
          "debug": false
        }
      }
    }
  }
}
```

Restart gateway after install/config changes. After restart, `openclaw plugins info openclaw-topic-shift-reset` should show `Status: loaded`.

## Quick start test

1. Temporarily set `dryRun: true` and `debug: true`.
2. Send normal messages on one topic.
3. Switch to a clearly different topic.
4. Watch logs for `classify`, `suspect`, `rotate-hard`/`rotate-soft`, and `would-rotate`.
5. Set `dryRun: false` when behavior looks good.

## Presets

- `conservative`: fewer resets, more confirmation.
- `balanced`: default.
- `aggressive`: faster/more sensitive resets.

Default preset internals:

| Key | conservative | balanced | aggressive |
| --- | --- | --- | --- |
| `historyWindow` | `12` | `10` | `8` |
| `minHistoryMessages` | `4` | `3` | `2` |
| `minMeaningfulTokens` | `7` | `6` | `5` |
| `softConsecutiveSignals` | `3` | `2` | `1` |
| `cooldownMinutes` | `10` | `5` | `2` |
| `softScoreThreshold` | `0.80` | `0.72` | `0.64` |
| `hardScoreThreshold` | `0.92` | `0.86` | `0.78` |

## Embeddings

Canonical key: `embedding`.

```json
{
  "embedding": {
    "provider": "auto",
    "model": "text-embedding-3-small",
    "baseUrl": "https://api.openai.com/v1",
    "timeoutMs": 7000
  }
}
```

Provider options:

- `auto` (default)
- `openai`
- `ollama`
- `none` (lexical only)

## Soft suspect clarification

When the classifier sees a soft topic-shift signal (`suspect`) but not enough confidence to rotate yet, the plugin can inject one-turn steer context so the model asks a brief clarification question before continuing.

```json
{
  "softSuspect": {
    "action": "ask",
    "mode": "strict",
    "prompt": "Potential topic shift detected. Ask one short clarification question to confirm the user's new goal before proceeding.",
    "ttlSeconds": 120
  }
}
```

- `action`: `ask` (default) or `none`.
- `mode`: `strict` (default, require clarification turn before soft-confirm reset) or `best_effort` (legacy timing-based behavior).
- `prompt`: optional custom steer text.
- `ttlSeconds`: max age before a pending steer expires.

## Logs

```bash
openclaw logs --follow --plain | rg topic-shift-reset
```

## Log reference

All plugin logs are prefixed with `topic-shift-reset:`.

### Info

- `embedding backend <name>`
  Embeddings are active (`openai:*` or `ollama:*` backend).
- `embedding backend unavailable, using lexical-only mode`
  No embedding backend is available; lexical signals only.
- `restored state sessions=<n> rotations=<n>`
  Persisted runtime state restored at startup.
- `orphan-recovery recovered=<n> store=<...>`
  Re-linked legacy orphan transcript files (`*.jsonl`) back into session-store entries.
- `would-rotate source=<user|agent> reason=<...> session=<...> ...`
  Dry-run rotation decision; no session mutation is written.
- `rotated source=<user|agent> reason=<...> session=<...> ... handoff=<0|1> archived=<0|1>`
  Rotation executed (new `sessionId` written). `handoff=1` means handoff context was enqueued.
  `archived=1` means the previous transcript file was archived as `.reset.<timestamp>`.

### Debug (`debug: true`)

- `classify source=<...> kind=<warmup|stable|suspect|rotate-hard|rotate-soft> reason=<...> ... textHash=<...> tokens=[...] text="..."`
  Full classifier output and metrics plus a compact message preview for a processed message.
- `suspect-queued session=<...>`
  Soft-suspect state queued for clarification steering.
- `ask-injected session=<...>`
  Clarification steer was injected into prompt build for this session.
- `ask-resolved user-reply session=<...>`
  A new user reply arrived after the injected clarification turn.
- `ask-blocked-waiting-injection session=<...>`
  Strict mode prevented soft-confirm reset until clarification steer is injected.
- `skip-internal-provider source=<...> provider=<...> session=<...>`
  Skipped event from internal/non-user provider (for example cron/system paths).
- `skip-low-signal source=<...> session=<...> chars=<n> tokens=<n>`
  Skipped message because it did not meet minimum signal thresholds.
- `user-route-skip channel=<...> peer=<...> err=<...>`
  User-message route resolution failed, so the inbound event was ignored.
- `agent-route-skip channel=<...> peer=<...> err=<...>`
  Agent-message route resolution failed, so the outbound event was ignored.
- `state-flushed reason=<scheduled|urgent|gateway-stop> sessions=<n> rotations=<n>`
  In-memory classifier state flushed to persistence storage.

### Warn

- `rotate failed no-session-entry session=<...>`
  Rotation was requested but no matching session entry was found to mutate.
- `handoff tail fallback full-read file=<...>`
  Tail read optimization fell back to a full transcript read.
- `handoff read failed file=<...> err=<...>`
  Could not read prior session transcript for handoff injection.
- `reset archive failed file=<...> err=<...>`
  Could not archive the prior session transcript after rotation.
- `orphan-recovery failed store=<...> err=<...>`
  Legacy orphan recovery scan failed for this session store.
- `persistence disabled (state path): <err>`
  Plugin could not resolve state path; persistence is disabled.
- `state flush failed err=<...>`
  Failed to write persistent state.
- `state restore failed err=<...>`
  Failed to read/parse persistent state.
- `state version mismatch expected=<...> got=<...>; ignoring persisted state`
  Stored persistence schema version differs; old state is ignored.
- `embedding backend init failed: <err>`
  Embedding backend initialization failed at startup.
- `embeddings error backend=<name> err=<...>`
  Runtime embedding request failed for a message; processing continues.

## Advanced tuning

Use `config.advanced` only if needed. Full reference:

- `docs/configuration.md`

## Upgrade

To update to the latest npm release in your OpenClaw instance:

```bash
openclaw plugins update openclaw-topic-shift-reset
openclaw plugins info openclaw-topic-shift-reset
```

Then restart gateway.

`0.2.0` is a breaking config release: legacy alias keys were removed. If startup fails validation, migrate to canonical `embedding` and `handoff` objects (see `docs/configuration.md`).

## Local development

No build step is required. OpenClaw loads `src/index.ts` via jiti.

## Known tradeoff (plugin-only)

This plugin cannot guarantee 100% that the triggering message becomes the first persisted message of the new session because resets happen in runtime hooks and provider pipelines vary.
