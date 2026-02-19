# openclaw-topic-shift-reset

OpenClaw plugin that detects topic shifts and rotates to a fresh session automatically.

## Quick start config

Most users should only set these fields:

```json
{
  "plugins": {
    "entries": {
      "openclaw-topic-shift-reset": {
        "enabled": true,
        "config": {
          "enabled": true,
          "preset": "balanced",
          "embeddings": "auto",
          "handoff": "summary",
          "dryRun": true,
          "debug": true
        }
      }
    }
  }
}
```

Then:

1. Run with `dryRun: true` and `debug: true`.
2. Send normal messages on one topic.
3. Switch to a clearly different topic.
4. Watch logs for `classify`, `suspect`, `rotate-hard`/`rotate-soft`, `dry-run rotate`.
5. Set `dryRun: false` when behavior looks good.

## Presets

- `conservative`: fewer resets, more confirmation
- `balanced`: default
- `aggressive`: faster/more sensitive resets

## Embeddings

`embeddings` supports:

- `auto` (default)
- `openai`
- `ollama`
- `none` (lexical only)

## Install locally

```bash
openclaw plugins install --link ~/Projects/openclaw-topic-shift-reset
openclaw plugins enable openclaw-topic-shift-reset
openclaw plugins info openclaw-topic-shift-reset
```

Restart gateway after install/config changes.

## Logs

```bash
openclaw logs --follow --plain | rg topic-shift-reset
```

## Advanced tuning

Use `config.advanced` only if needed. Full reference:

- `docs/configuration.md`

Legacy top-level tuning keys are still accepted for backward compatibility.

## Local development

No build step is required. OpenClaw loads `src/index.ts` via jiti.

## Publish

```bash
cd ~/Projects/openclaw-topic-shift-reset
npm publish
npm view openclaw-topic-shift-reset version --userconfig "$(mktemp)"
```

## Known tradeoff (plugin-only)

This plugin improves timing with fast path + fallback, but cannot guarantee 100% that the triggering message becomes the first persisted message of the new session without core pre-session hooks.
