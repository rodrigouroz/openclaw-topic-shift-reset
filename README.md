# openclaw-topic-shift-reset

OpenClaw plugin that detects topic shifts and rotates to a fresh session automatically.

## Why this plugin exists

OpenClaw builds each model call with the current prompt plus session history. As one session accumulates mixed topics, prompts get larger, token usage grows, and context-overflow/compaction pressure increases.

This plugin tries to prevent that by detecting topic shifts and rotating to a new session key when confidence is high. In practice, that keeps subsequent turns focused on the new topic, which usually means:

- fewer prompt tokens per turn after a shift
- less stale context bleeding into new questions
- lower chance of overflow/compaction churn on long chats

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

## Logs

```bash
openclaw logs --follow --plain | rg topic-shift-reset
```

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

This plugin improves timing with fast path + fallback, but cannot guarantee 100% that the triggering message becomes the first persisted message of the new session without core pre-session hooks.
