# Configuration

## Recommended public config

Use this minimal config for normal users:

```json
{
  "enabled": true,
  "preset": "balanced",
  "embeddings": "auto",
  "handoff": "summary",
  "dryRun": false,
  "debug": false
}
```

## Public options

- `enabled`: turn plugin behavior on/off.
- `preset`: `conservative | balanced | aggressive`.
- `embeddings`: `auto | openai | ollama | none`.
- `handoff`: `none | summary | verbatim`.
- `dryRun`: if `true`, logs decisions but never rotates sessions.
- `debug`: if `true`, emits per-message metrics logs.

## Built-in presets defaults

`preset` controls the classifier layer. These are the built-in defaults:

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

These defaults apply in all presets unless overridden:

- `handoff`: `summary`
- `handoffLastN`: `6`
- `handoffMaxChars`: `220`
- `embeddings`: `auto`
- `embedding.timeoutMs`: `7000`
- `minSignalChars`: `20`
- `minSignalTokenCount`: `3`
- `minSignalEntropy`: `1.2`
- `stripEnvelope`: `true`

## Advanced overrides

The runtime resolves config in this order:

1. Built-in preset defaults.
2. Shared defaults.
3. `advanced` overrides (only the keys you set).

Power users can override behavior via `advanced`:

```json
{
  "preset": "balanced",
  "advanced": {
    "cooldownMinutes": 3,
    "minSignalEntropy": 1.4,
    "softConsecutiveSignals": 2,
    "softScoreThreshold": 0.7,
    "hardScoreThreshold": 0.84,
    "handoffLastN": 5,
    "embedding": {
      "model": "text-embedding-3-small",
      "timeoutMs": 7000
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
- `stripEnvelope`
- `softConsecutiveSignals`
- `cooldownMinutes`
- `softScoreThreshold`
- `hardScoreThreshold`
- `softSimilarityThreshold`
- `hardSimilarityThreshold`
- `softNoveltyThreshold`
- `hardNoveltyThreshold`
- `ignoredProviders`
- `handoff`
- `handoffLastN`
- `handoffMaxChars`
- `embeddings`
- `embedding.provider`
- `embedding.model`
- `embedding.baseUrl`
- `embedding.apiKey`
- `embedding.timeoutMs`

Notes:

- Top-level public keys stay minimal: `enabled`, `preset`, `embeddings`, `handoff`, `dryRun`, `debug`.
- Tuning keys outside `advanced` are rejected by config schema validation.

## Log interpretation

Classifier logs look like:

`topic-shift-reset: classify source=<fast|fallback> kind=<...> reason=<...> ...`

Kinds:

- `warmup`: not enough baseline history yet.
- `stable`: no shift action.
- `suspect`: first soft signal; waiting confirmation.
- `rotate-hard`: immediate reset trigger.
- `rotate-soft`: soft signal confirmed.

Reasons:

- `warmup`
- `stable`
- `cooldown`
- `skip-low-signal`
- `soft-suspect`
- `soft-confirmed`
- `hard-threshold`

Other lines:

- `dry-run rotate`: would have rotated, but `dryRun=true`.
- `rotated`: actual session rotation happened.
