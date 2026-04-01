# OpenClaw Thinking Orchestrator

这个插件现在是合并后的执行编排插件。

它在任务真正执行前做两件事：
- 按 `agent + model + prompt` 计算本轮 session 的 `thinking level`
- 给主 agent 注入精简的执行摘要

目标不是简单覆盖 `/think`，而是把思考强度和执行约束统一收口：
- 可以按 agent 固定等级
- 可以按模型限制等级范围
- 可以让 `auto` 根据任务内容自动判断
- 可以防止模型被设到自己根本不支持的等级
- 可以吸收原 `openclaw-goal-compiler` 的目标摘要能力

## 配置文件位置

生产配置在：
- [/Users/rico/.openclaw/openclaw.json](/Users/rico/.openclaw/openclaw.json)

插件键路径：
- `plugins.entries.openclaw-thinking-orchestrator`

运行时预览文件：
- [/Users/rico/.openclaw/workspace/.openclaw/thinking-orchestrator-preview.json](/Users/rico/.openclaw/workspace/.openclaw/thinking-orchestrator-preview.json)

## 支持的等级

插件当前支持这 5 个值：
- `off`
- `low`
- `medium`
- `high`
- `auto`

内部归一化规则：
- `minimal` 会归一化到 `low`
- `xhigh` 会归一化到 `high`
- `adaptive` 会归一化到 `medium`

这意味着：
- 你可以从 OpenClaw 原生命令里传入更多等级
- 但插件最终只会落到上面这 4 档固定等级，或者 `auto`

## 配置项解释

### 顶层配置项

```json
{
  "enabled": true,
  "defaultMode": "auto",
  "defaultLevel": "medium",
  "minimumLevel": "off",
  "injectGoalBrief": true,
  "goalMaxConstraints": 6,
  "respectExplicitThinkDirective": true,
  "previewFile": "/Users/rico/.openclaw/workspace/.openclaw/thinking-orchestrator-preview.json",
  "goalPreviewFile": "/Users/rico/.openclaw/workspace/.openclaw/goal-compiler-preview.json",
  "agentRules": {},
  "modelRules": {}
}
```

各字段含义：

- `enabled`
  - 是否启用插件。

- `defaultMode`
  - 全局默认策略。
  - 可选：`off | low | medium | high | auto`

- `defaultLevel`
  - 当系统需要一个保底等级时使用。
  - 建议设置成你能接受的默认稳定值。

- `minimumLevel`
  - 全局最低等级。
  - 用于防止 `auto` 过低。

- `maximumLevel`
  - 全局最高等级。
  - 可选。
  - 用于防止 `auto` 过高。

- `respectExplicitThinkDirective`
  - 是否尊重用户或命令显式给出的 `/think ...`
  - `true` 表示如果本轮已经明确指定，就不再由插件覆盖。

- `previewFile`
  - 最近一次决策结果写到哪个文件。

- `agentRules`
  - 按 agent 设置策略。

- `modelRules`
  - 按模型设置策略。
  - 建议优先使用完整模型名精确匹配。
  - 如果想按 provider 整体限制，使用前缀通配，例如：`bltcy/*`

- `autoPolicy`
  - 可选。
  - 如果不写，默认从项目文件读取：
    - [/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/src/default-auto-policy.json](/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/src/default-auto-policy.json)

## 规则匹配方式

当前匹配顺序是：
- 精确 key
- 小写后的精确 key
- `*`
- `default`
- `other`
- 前缀通配，例如 `bltcy/*`

当前实现已经不再使用宽泛的字符串包含匹配。

这样做的原因是：
- 宽泛 `includes` 容易把本来属于 A 模型的规则错误套到 B 模型上
- 模型一多，配置会变得不可预测

### `agentRules` / `modelRules` 中的字段

每条 rule 支持这些字段：

- `mode`
  - `off | low | medium | high | auto`

- `level`
  - 固定等级别名。
  - 一般和 `mode` 二选一即可。

- `minimumLevel`
  - 该规则的最低等级。

- `maximumLevel`
  - 该规则的最高等级。

- `allowedLevels`
  - 明确允许的等级集合。
  - 例如：
    - `["off", "low"]`
    - `["medium"]`

- `only`
  - 单等级强限制。
  - 等价于只允许一个值。
  - 例如：
    - `"only": "low"`

## 解析顺序

插件当前的决策顺序是：

1. 如果 prompt 里已经有显式 `/think ...`，并且 `respectExplicitThinkDirective=true`，则插件不覆盖。
2. 如果 `agentRules` 对当前 agent 给的是固定档位，先用 agent 的固定档位做基础等级。
3. 否则如果 `modelRules` 对当前模型给的是固定档位，先用模型固定档位做基础等级。
4. 否则如果全局 `defaultMode` 不是 `auto`，使用全局固定档位。
5. 否则走 `auto`，由 prompt 内容决定基础等级。
6. 用 `minimumLevel / maximumLevel` 对基础等级做夹紧。
7. 如果存在 `allowedLevels` 或 `only`，最终再收敛到允许的等级内。

一句话总结：
- `agent` 先表达“想用多高”
- `model` 再表达“最多只能多高”
- 最终结果取可兼容值

## 典型配置示例

### 示例 1：只配 `default` 和 `main`

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

这个配置的含义：
- `main` 默认固定用 `medium`
- Gemini 这条模型链也只允许 `medium`
- MiniMax 让 `auto` 决定，但不低于 `low`，不高于 `high`

### 示例 2：agent 想高，但模型只能低

```json
{
  "agentRules": {
    "main": {
      "mode": "high"
    }
  },
  "modelRules": {
    "some-provider/some-model": {
      "only": "low"
    }
  }
}
```

结果：
- `agent` 想用 `high`
- `model` 明确只允许 `low`
- 最终一定是 `low`

### 示例 3：模型只允许一小段区间

```json
{
  "modelRules": {
    "minimax/MiniMax-M2.5-highspeed": {
      "minimumLevel": "low",
      "maximumLevel": "high"
    }
  }
}
```

结果：
- `off` 不会被自动选中
- `xhigh` 也不会被落到最终值
- 最终只会在 `low / medium / high` 里收敛

## `auto` 是怎么工作的

`auto` 并不是调用模型自带 adaptive，而是插件本地做一层任务分类。

默认关键词策略文件在：
- [/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/src/default-auto-policy.json](/Users/rico/.openclaw/extensions/openclaw-thinking-orchestrator/src/default-auto-policy.json)

里面的分类有：
- `planningKeywords`
- `implementationKeywords`
- `simpleKeywords`
- `reviewKeywords`
- `researchKeywords`

当前行为大致是：
- 很简单的“只回复 / 只返回 / 状态检查”倾向 `off`
- 实现、修复、脚本、测试类倾向 `medium`
- 方案、评审、研究、调研类倾向 `high`

然后再被模型边界收紧。

## 当前环境的建议用法

结合你目前的模型情况，比较稳的做法是：

- `main + Gemini`
  - 固定到模型已经验证稳定的档位
  - 如果该 provider 只稳定支持 `medium`，就直接：
    - `allowedLevels: ["medium"]`

- `MiniMax`
  - 可以用 `auto`
  - 再用 `minimumLevel / maximumLevel` 限制在 `low..high`

不要假设所有 provider 都能正确识别每一个 thinking 等级。  
如果 provider 实际只支持一部分档位，用 `allowedLevels` 或 `only` 明确写死，比靠猜更稳。

## 如何验证是否生效

建议按这个顺序验证：

1. `npm test`
2. `openclaw config validate`
3. `openclaw gateway restart`
4. 查看预览文件：
   - [/Users/rico/.openclaw/workspace/.openclaw/thinking-orchestrator-preview.json](/Users/rico/.openclaw/workspace/.openclaw/thinking-orchestrator-preview.json)

预览文件里可以看到：
- 当前 agent
- 当前模型
- baseLevel
- finalLevel
- min/max
- allowedLevels

这样你不用猜插件到底最后选了什么。
