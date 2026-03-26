# OpenClaw Thinking Orchestrator

Per-run thinking policy orchestration for OpenClaw.

## What it does

- Applies thinking level before dispatch for message-driven tasks.
- Supports per-agent and per-model policy composition.
- Supports `off`, `low`, `medium`, `high`, and `auto`.
- Supports global and per-rule `minimumLevel` / `maximumLevel`.
- Supports model-side `allowedLevels` and `only` for providers that only work at specific levels.
- Uses conservative bound resolution when agent intent and model bounds conflict.

## Resolution model

1. If the inbound message contains an explicit `/think` directive, the plugin does nothing.
2. Agent rule decides the preferred level when it is fixed.
3. Otherwise model rule decides the preferred level when it is fixed.
4. Otherwise the plugin uses `auto`.
5. Final level is clamped by global, agent, and model bounds.
6. If `allowedLevels` or `only` is configured, the final level is snapped to a permitted level.

## Why model bounds matter

Some providers advertise reasoning support but behave poorly at higher levels.

Current production defaults:
- `bltcy/gemini-3.1-flash-lite-preview-thinking-medium`: fixed to `medium`
- `minimax/MiniMax-M2.5-highspeed`: bounded to `low..high`
- `minimax/MiniMax-M2.7-highspeed`: bounded to `low..high`

## Config location

Configured in:

- `/Users/rico/.openclaw/openclaw.json`

Plugin entry:

- `plugins.entries.openclaw-thinking-orchestrator`

## Validation

- `npm test`
- `openclaw config validate`
- `openclaw gateway restart`
