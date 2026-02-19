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

## Preset behavior

### conservative

- Fewer resets, more confirmation.
- Higher thresholds and longer cooldown.

### balanced (default)

- Current recommended default for most users.

### aggressive

- Faster resets.
- Lower thresholds and shorter cooldown.

## Advanced overrides

Power users can override preset internals via `advanced`:

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

## Backward compatibility

Legacy top-level tuning keys are still accepted by the runtime parser for existing configs. New configs should use the simplified public fields plus optional `advanced` overrides.
