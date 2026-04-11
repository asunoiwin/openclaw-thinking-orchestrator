const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plugin = require('../src/index.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-orchestrator-'));
const agentsRoot = path.join(tempRoot, 'agents');
const previewFile = path.join(tempRoot, 'preview.json');
const historyFile = path.join(tempRoot, 'history.jsonl');
const briefsDir = path.join(tempRoot, 'briefs');
const agentId = 'main';
const sessionKey = 'agent:main:main';
const sessionId = 'session-1';
const sessionFile = path.join(agentsRoot, agentId, 'sessions', `${sessionId}.jsonl`);
const registryFile = path.join(agentsRoot, agentId, 'sessions', 'sessions.json');

fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.writeFileSync(
  registryFile,
  JSON.stringify({
    [sessionKey]: {
      sessionId,
      sessionFile,
      thinkingLevel: 'medium',
      updatedAt: Date.now(),
    },
  }, null, 2),
  'utf8'
);
fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: sessionId }) + '\n', 'utf8');

const registeredTools = [];
const toolMap = new Map();
const handlers = {};

plugin.register({
  logger: { info() {} },
  pluginConfig: {
    enabled: true,
    previewFile,
    historyFile,
    briefsDir,
    agentsRoot,
    defaultMode: 'auto',
    defaultLevel: 'low',
    minimumLevel: 'off',
    maximumLevel: 'high',
    respectExplicitThinkDirective: true,
    agentRules: {
      main: {
        mode: 'auto',
      },
    },
  },
  registerTool(tool) {
    registeredTools.push(tool.name);
    toolMap.set(tool.name, tool);
  },
  on(name, handler) { handlers[name] = handler; },
});

assert.ok(registeredTools.includes('thinking_orchestrator_status'));
assert.ok(registeredTools.includes('thinking_orchestrator_analyze'));
assert.ok(registeredTools.includes('thinking_orchestrator_recent'));
assert.ok(registeredTools.includes('thinking_orchestrator_brief'));
assert.equal(typeof handlers.before_dispatch, 'function');

(async () => {
  await handlers.before_dispatch({
    prompt: '请做架构分析并比较两种方案的取舍',
    sessionKey,
    agentId: 'main',
    modelId: 'minimax/MiniMax-M2.7-highspeed',
  }, {});

  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  assert.equal(registry[sessionKey].thinkingLevel, 'high');

  const preview = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  assert.equal(preview.skipped, false);
  assert.equal(preview.decision.level, 'high');
  assert.equal(preview.decision.compactionHint, 'full');
  assert.equal(preview.artifactRef.kind, 'safe-task-brief');
  assert.equal(fs.existsSync(preview.artifactRef.path), true);
  const briefArtifact = JSON.parse(fs.readFileSync(preview.artifactRef.path, 'utf8'));
  assert.equal(briefArtifact.kind, 'safe-task-brief');
  assert.equal(briefArtifact.decision.level, 'high');
  assert.equal(briefArtifact.decision.compactionHint, 'full');
  assert.equal(briefArtifact.brief.compactionHint, 'full');
  assert.equal(briefArtifact.brief.language, 'zh');
  assert.ok(briefArtifact.brief.requestedActions.includes('analyze'));
  assert.ok(briefArtifact.brief.requestedActions.includes('compare'));
  const historyAfterHigh = fs.readFileSync(historyFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(historyAfterHigh.length, 1);
  assert.equal(historyAfterHigh[0].decision.level, 'high');
  assert.equal(historyAfterHigh[0].artifactRef.kind, 'safe-task-brief');

  const briefTool = toolMap.get('thinking_orchestrator_brief');
  const briefToolResult = await briefTool.execute({ sessionKey, agentId });
  assert.equal(briefToolResult.details.success, true);
  assert.equal(briefToolResult.details.artifact.kind, 'safe-task-brief');

  await handlers.before_dispatch({
    prompt: '请比较这个实现的 tradeoff，然后给出 root cause 分析',
    sessionKey,
    agentId: 'main',
    modelId: 'minimax/MiniMax-M2.7-highspeed',
  }, {});

  const previewZhEn = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  assert.equal(previewZhEn.decision.level, 'high');
  const mixedArtifact = JSON.parse(fs.readFileSync(previewZhEn.artifactRef.path, 'utf8'));
  assert.equal(mixedArtifact.brief.language, 'mixed');

  await handlers.before_dispatch({
    prompt: '请修复这个 bug 并补测试',
    sessionKey,
    agentId: 'main',
    modelId: 'minimax/MiniMax-M2.7-highspeed',
  }, {});

  const previewBuild = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  assert.equal(previewBuild.decision.level, 'medium');
  assert.equal(previewBuild.decision.compactionHint, 'auto');

  await handlers.before_dispatch({
    prompt: 'System: gateway.restart ok',
    sessionKey,
    agentId: 'main',
  }, {});

  const afterSystem = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  assert.equal(afterSystem[sessionKey].thinkingLevel, 'medium');
  const history = fs.readFileSync(historyFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(history.length, 4);
  assert.equal(history.at(-1).skipped, true);

  console.log('thinking-orchestrator smoke ok');
})();
