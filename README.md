# openclaw-topic-shift-reset

OpenClaw plugin that detects conversation topic drift and rotates the session to a fresh `sessionId`.

It runs on the `before_model_resolve` hook, so the reset can happen before the current prompt is processed.

Build tooling uses Bun and does not require a dependency install for local builds.

## How it works

- Tracks lexical tokens for each session.
- Computes drift using:
  - Jaccard similarity vs. recent history
  - Novelty ratio (how many tokens are new)
- Requires configurable consecutive drift signals.
- On trigger, rewrites the session-store entry with a new `sessionId`.

## Config (plugin entry)

```json
{
  "plugins": {
    "entries": {
      "topic-shift-reset": {
        "enabled": true,
        "config": {
          "similarityThreshold": 0.18,
          "minNoveltyRatio": 0.72,
          "consecutiveSignals": 2,
          "cooldownMinutes": 5,
          "dryRun": true,
          "debug": true
        }
      }
    }
  }
}
```

## Local development

```bash
bun run build
```

Optional watch mode:

```bash
bun run dev
```

## Local testing with OpenClaw

`openclaw plugins install --link` is the recommended path. You do not need `npm link`.

```bash
openclaw plugins install --link /absolute/path/to/openclaw-topic-shift-reset
openclaw plugins enable topic-shift-reset
openclaw plugins info topic-shift-reset
```

Then restart your OpenClaw gateway process.

Suggested first test:

- Set `dryRun: true`
- Set `debug: true`
- Send 3-5 messages on one topic, then switch to a clearly different topic.
- Check logs for `would rotate session`.

After tuning, set `dryRun: false`.

## Publish to npm

```bash
bun run clean
bun run build
npm publish
```

Verify:

```bash
npm view openclaw-topic-shift-reset version --userconfig "$(mktemp)"
```

## Notes

- This plugin keeps prior transcript files on disk; it only rotates the active session mapping.
- Minimum OpenClaw version: `2026.2.18` (plugin SDK/runtime expected by this package).
