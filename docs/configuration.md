# Configuration

## Canonical public config

This plugin now accepts one canonical key per concept:

```json
{
  "enabled": true,
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
    "ttlSeconds": 120
  },
  "dryRun": false,
  "debug": false
}
```

## Public options

Classifier inputs are limited to inbound user message text and successful outbound agent message text.

- `enabled`: plugin on/off.
- `preset`: `conservative | balanced | aggressive`.
- `embedding.provider`: `auto | openai | ollama | none`.
- `embedding.model`: optional model override for selected provider.
- `embedding.baseUrl`: optional provider base URL override.
- `embedding.apiKey`: optional explicit API key override.
- `embedding.timeoutMs`: embedding request timeout.
- `handoff.mode`: `none | summary | verbatim_last_n`.
- `handoff.lastN`: number of transcript messages to include in handoff.
- `handoff.maxChars`: per-message truncation cap in handoff text.
- `softSuspect.action`: `ask | none`.
- `softSuspect.prompt`: optional steer text injected on soft-suspect.
- `softSuspect.ttlSeconds`: expiry for pending soft-suspect steer.
- `dryRun`: logs would-rotate events without session resets.
- `debug`: emits per-message classifier diagnostics.

## Built-in preset defaults

| Key | conservative | balanced (default) | aggressive |
| --- | --- | --- | --- |
| `historyWindow` | `12` | `10` | `8` |
| `minHistoryMessages` | `4` | `3` | `2` |
| `minMeaningfulTokens` | `7` | `6` | `5` |
| `minTokenLength` | `2` | `2` | `2` |
| `softConsecutiveSignals` | `3` | `2` | `1` |
| `cooldownMinutes` | `10` | `5` | `2` |
| `softScoreThreshold` | `0.80` | `0.72` | `0.64` |
| `hardScoreThreshold` | `0.92` | `0.86` | `0.78` |
| `softSimilarityThreshold` | `0.30` | `0.36` | `0.46` |
| `hardSimilarityThreshold` | `0.18` | `0.24` | `0.34` |
| `softNoveltyThreshold` | `0.66` | `0.58` | `0.48` |
| `hardNoveltyThreshold` | `0.80` | `0.74` | `0.60` |

## Shared defaults

- `embedding.provider`: `auto`
- `embedding.timeoutMs`: `7000`
- `handoff.mode`: `summary`
- `handoff.lastN`: `6`
- `handoff.maxChars`: `220`
- `softSuspect.action`: `ask`
- `softSuspect.ttlSeconds`: `120`
- `advanced.minSignalChars`: `20`
- `advanced.minSignalTokenCount`: `3`
- `advanced.minSignalEntropy`: `1.2`
- `advanced.minUniqueTokenRatio`: `0.34`
- `advanced.shortMessageTokenLimit`: `6`
- `advanced.embeddingTriggerMargin`: `0.08`
- `advanced.stripEnvelope`: `true`
- `advanced.handoffTailReadMaxBytes`: `524288`

## Advanced overrides

Advanced keys let you override classifier internals and envelope stripping:

```json
{
  "preset": "balanced",
  "advanced": {
    "cooldownMinutes": 3,
    "embeddingTriggerMargin": 0.1,
    "minUniqueTokenRatio": 0.4,
    "stripRules": {
      "dropLinePrefixPatterns": ["^[A-Za-z][A-Za-z _-]{0,30}:\\s*\\["],
      "dropFencedBlockAfterHeaderPatterns": ["^[A-Za-z][A-Za-z _-]{0,40}:\\s*\\([^)]*(metadata|context)[^)]*\\):?$"]
    }
  }
}
```

Advanced keys:

- `historyWindow`
- `minHistoryMessages`
- `minMeaningfulTokens`
- `minTokenLength`
- `minSignalChars`
- `minSignalTokenCount`
- `minSignalEntropy`
- `minUniqueTokenRatio`
- `shortMessageTokenLimit`
- `embeddingTriggerMargin`
- `stripEnvelope`
- `stripRules.dropLinePrefixPatterns`
- `stripRules.dropExactLines`
- `stripRules.dropFencedBlockAfterHeaderPatterns`
- `handoffTailReadMaxBytes`
- `softConsecutiveSignals`
- `cooldownMinutes`
- `softScoreThreshold`
- `hardScoreThreshold`
- `softSimilarityThreshold`
- `hardSimilarityThreshold`
- `softNoveltyThreshold`
- `hardNoveltyThreshold`
- `ignoredProviders`

`ignoredProviders` expects canonical provider IDs:

- `telegram`, `whatsapp`, `signal`, `discord`, `slack`, `matrix`, `msteams`, `imessage`, `web`, `voice`
- internal/system-style providers like `cron-event`, `heartbeat`, `exec-event`

## Migration note

Legacy alias keys are not supported in this release. Config validation fails if you use old keys such as:

- `embeddings` (top-level)
- string `handoff` values (top-level)
- `handoffMode`, `handoffLastN`, `handoffMaxChars`
- `advanced.embedding`, `advanced.embeddings`, `advanced.handoff*`
- previous top-level tuning keys

## Runtime persistence

Classifier runtime state is persisted automatically under the OpenClaw state directory (`plugins/<plugin-id>/runtime-state.v1.json`).

- Persisted: per-session topic history, pending soft-signal windows, topic centroid, rotation dedupe map.
- Not persisted: transient message-event dedupe cache.
- No extra config is required.

## Log interpretation

Classifier logs look like:

`topic-shift-reset: classify source=<user|agent> kind=<...> reason=<...> ...`

Kinds:

- `warmup`: not enough baseline history yet.
- `stable`: no shift action.
- `suspect`: first soft signal; waiting confirmation.
- `rotate-hard`: immediate reset trigger.
- `rotate-soft`: soft signal confirmed.

Other lines:

- `skip-low-signal`: message skipped by hard signal floor (`minSignalChars`/`minSignalTokenCount`).
- `would-rotate`: `dryRun=true` synthetic rotate event (no reset mutation).
- `rotated`: actual session rotation happened.
- `classify` / `skip-low-signal` / `user-route-skip` / `agent-route-skip`: debug-level diagnostics (`debug=true`).
