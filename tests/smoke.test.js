const assert = require('node:assert/strict');
const plugin = require('../src/index.js');

assert.equal(typeof plugin.register, 'function');

const preview = plugin.__private?.buildDecision?.({
  prompt: '请给我一个架构方案和风险分析',
  agentId: 'main',
  modelRef: 'bltcy/gemini-3.1-flash-lite-preview',
  cfg: {},
  pluginCfg: {
    defaultMode: 'auto',
    defaultLevel: 'low',
    minimumLevel: 'off',
    agentRules: {
      main: { mode: 'high' },
    },
    modelRules: {
      'bltcy/gemini-3.1-flash-lite-preview': { allowedLevels: ['off', 'low'] },
    },
    autoPolicy: {},
  },
});

assert.equal(preview.baseLevel, 'high');
assert.equal(preview.finalLevel, 'low');
assert.deepEqual(preview.allowedLevels, ['off', 'low']);

const exactMatch = plugin.__private?.buildDecision?.({
  prompt: '请给我一个架构方案和风险分析',
  agentId: 'main',
  modelRef: 'bltcy/gemini-3.1-flash-lite-preview',
  cfg: {},
  pluginCfg: {
    defaultMode: 'auto',
    defaultLevel: 'low',
    minimumLevel: 'off',
    agentRules: {},
    modelRules: {
      'gemini': { mode: 'off' },
      'bltcy/gemini-3.1-flash-lite-preview': { mode: 'medium' },
    },
    autoPolicy: {},
  },
});

assert.equal(exactMatch.finalLevel, 'medium');

const goal = plugin.__private.compileGoal('请做一份跨境商品调研方案并输出到 /Users/rico/Desktop/report.md');
assert.equal(goal.taskKind, 'research');
assert.match(plugin.__private.formatExecutionBrief(goal), /优先工具：search_orchestrator_research/);
assert.equal(plugin.__private.isGoalInjectionEnabled({}), true);
assert.equal(plugin.__private.isGoalInjectionEnabled({ injectGoalBrief: false }), false);

const skillGoal = plugin.__private.compileGoal('安装 clawhub 插件，去 GitHub 搜索相关 skill，并看看还有没有强化搜索的插件或者 skill');
assert.equal(skillGoal.taskKind, 'skill_discovery');
assert.match(skillGoal.searchPlan.join('\n'), /ClawHub|GitHub|本地已安装/);

console.log('thinking orchestrator smoke test passed');
