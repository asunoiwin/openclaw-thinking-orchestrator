# OpenClaw Thinking Orchestrator

Per-run thinking policy orchestration for OpenClaw.

Chinese documentation:
- [README.zh-CN.md](/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/README.zh-CN.md)

## Purpose

This plugin sets the session thinking level before execution starts.

It supports:
- Global default policy
- Per-agent policy
- Per-model policy
- Automatic level selection (`auto`)
- Hard model limits through `allowedLevels` or `only`

## Supported values

- `off`
- `low`
- `medium`
- `high`
- `auto`

Normalization rules:
- `minimal` -> `low`
- `xhigh` -> `high`
- `adaptive` -> `medium`

This normalization happens inside the plugin so unsupported provider-specific labels do not leak into runtime.

## Resolution order

The plugin resolves the final level in this order:

1. If the message already contains `/think ...` and `respectExplicitThinkDirective=true`, do nothing.
2. If the agent rule uses a fixed mode, use that as the base level.
3. Otherwise if the model rule uses a fixed mode, use that as the base level.
4. Otherwise if the global rule uses a fixed mode, use that as the base level.
5. Otherwise compute the base level from `autoPolicy`.
6. Clamp the base level by merged `minimumLevel` / `maximumLevel`.
7. If `allowedLevels` or `only` is configured, snap the final level to an allowed value.

Practical meaning:
- Agent rules decide intent first.
- Model rules define hard capability bounds.
- Final output is the compatible result of both.

## Config location

Configure this plugin in:
- [/Users/rico/.openclaw/openclaw.json](/Users/rico/.openclaw/openclaw.json)

Plugin key:
- `plugins.entries.openclaw-thinking-orchestrator`

## Config schema

Example:

```json
{
  "plugins": {
    "entries": {
      "openclaw-thinking-orchestrator": {
        "enabled": true,
        "config": {
          "enabled": true,
          "defaultMode": "auto",
          "defaultLevel": "medium",
          "minimumLevel": "off",
          "respectExplicitThinkDirective": true,
          "previewFile": "/Users/rico/.openclaw/workspace/.openclaw/thinking-orchestrator-preview.json",
          "agentRules": {
            "main": {
              "mode": "medium"
            }
          },
          "modelRules": {
            "bltcy/gemini-3.1-flash-lite-preview": {
              "mode": "medium",
              "allowedLevels": ["medium"]
            },
            "minimax/MiniMax-M2.7-highspeed": {
              "mode": "auto",
              "minimumLevel": "low",
              "maximumLevel": "high"
            }
          }
        }
      }
    }
  }
}
```

## Rule matching

Rule lookup is intentionally conservative.

Matching order:
- exact key match
- lowercase exact key match
- `*`
- `default`
- `other`
- prefix wildcard such as `bltcy/*`

It no longer uses broad substring matching.

This matters because broad substring matching can silently apply the wrong model rule.

## Config fields

### Top-level plugin config

- `enabled`
  - Boolean.
  - Turns the plugin on or off.

- `defaultMode`
  - One of `off | low | medium | high | auto`.
  - Defines the default policy for unmatched tasks.

- `defaultLevel`
  - Default fallback level when needed.
  - Usually keep this aligned with your safe baseline.

- `minimumLevel`
  - Global lower bound.

- `maximumLevel`
  - Global upper bound.
  - Optional.

- `respectExplicitThinkDirective`
  - Boolean.
  - If true, user-provided `/think ...` wins and the plugin does not override it.

- `previewFile`
  - Path to the latest decision preview JSON.

- `agentRules`
  - Object keyed by agent id.
  - Used to control preferred level by agent role.

- `modelRules`
  - Object keyed by full model reference such as `provider/model-id`.
  - Used to express provider capability bounds.
  - Prefer exact keys.
  - If you want a provider-wide rule, use a prefix wildcard such as `bltcy/*`.

- `autoPolicy`
  - Optional keyword policy object.
  - If omitted, the plugin loads defaults from:
    - [/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/src/default-auto-policy.json](/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/src/default-auto-policy.json)

### Rule fields

Each rule may contain:

- `mode`
  - `off | low | medium | high | auto`

- `level`
  - Alias field for fixed mode style configs.

- `minimumLevel`
  - Lower bound for the rule.

- `maximumLevel`
  - Upper bound for the rule.

- `allowedLevels`
  - Explicit allow-list.
  - Example: `["off", "low"]`

- `only`
  - Strong single-level restriction.
  - Equivalent to `allowedLevels` with one value.

## Conflict examples

### Agent wants high, model only supports low

```json
{
  "agentRules": {
    "main": { "mode": "high" }
  },
  "modelRules": {
    "some-model": { "only": "low" }
  }
}
```

Result:
- Base level starts at `high`
- Model restriction forces final level to `low`

### Global auto, agent medium, model low-high

```json
{
  "defaultMode": "auto",
  "agentRules": {
    "main": { "mode": "medium" }
  },
  "modelRules": {
    "minimax/MiniMax-M2.7-highspeed": {
      "minimumLevel": "low",
      "maximumLevel": "high"
    }
  }
}
```

Result:
- Final level is `medium`

## Auto mode

`auto` classifies the prompt using local keyword groups.

Default policy file:
- [/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/src/default-auto-policy.json](/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/src/default-auto-policy.json)

Categories:
- `planningKeywords`
- `implementationKeywords`
- `simpleKeywords`
- `reviewKeywords`
- `researchKeywords`

Current behavior:
- Very simple prompts can drop to `off`
- Implementation tasks tend toward `medium`
- Planning, review, and research tend toward `high`
- Final output is still limited by model bounds

## Current production pattern

Recommended pattern for the current environment:
- `main` with Gemini: fixed `medium` or whatever the provider is proven to support
- MiniMax models: `auto` with `low..high`

Do not assume every provider supports every level. Use `allowedLevels` or `only` when the provider is known to be fragile.

## Validation

- `npm test`
- `openclaw config validate`
- `openclaw gateway restart`

## Runtime preview

The latest computed decision is written to:
- [/Users/rico/.openclaw/workspace/.openclaw/thinking-orchestrator-preview.json](/Users/rico/.openclaw/workspace/.openclaw/thinking-orchestrator-preview.json)
