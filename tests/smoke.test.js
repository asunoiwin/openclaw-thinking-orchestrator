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
console.log('thinking orchestrator smoke test passed');
