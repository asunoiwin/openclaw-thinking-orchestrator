const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadConfig,
  resolveStorePath,
  updateSessionStore,
} = require('/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/config-runtime.js');
const DEFAULT_AUTO_POLICY = require('./default-auto-policy.json');

const HOME = os.homedir();
const DEFAULT_PREVIEW = path.join(HOME, '.openclaw', 'workspace', '.openclaw', 'thinking-orchestrator-preview.json');
const THINK_LEVELS = ['off', 'low', 'medium', 'high'];
const SUPPORTED_LEVELS = new Set(['off', 'low', 'medium', 'high', 'auto']);

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function normalizeLevel(value, fallback = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'minimal') return 'low';
  if (raw === 'xhigh') return 'high';
  if (raw === 'adaptive') return 'medium';
  return THINK_LEVELS.includes(raw) ? raw : fallback;
}

function normalizeMode(value, fallback = 'auto') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  return SUPPORTED_LEVELS.has(raw) ? raw : fallback;
}

function levelIndex(level) {
  return THINK_LEVELS.indexOf(normalizeLevel(level, 'off'));
}

function clampLevel(level, minLevel, maxLevel) {
  const candidate = levelIndex(level);
  const minIndex = minLevel ? levelIndex(minLevel) : 0;
  const maxIndex = maxLevel ? levelIndex(maxLevel) : THINK_LEVELS.length - 1;
  if (minIndex > maxIndex) return THINK_LEVELS[maxIndex];
  const clamped = Math.max(minIndex, Math.min(candidate, maxIndex));
  return THINK_LEVELS[clamped];
}

function normalizeLevelList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeLevel(value, null))
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .sort((a, b) => levelIndex(a) - levelIndex(b));
}

function resolveEventAgentId(event, ctx) {
  const direct = String(ctx?.agentId || event?.agentId || '').trim();
  if (direct) return direct;
  const nested = String(event?.agent?.id || event?.agent?.name || event?.context?.agentId || '').trim();
  if (nested) return nested;
  const sessionKey = String(ctx?.sessionKey || event?.sessionKey || event?.session || '').trim();
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] || 'main';
}

function getPromptText(event) {
  return String(event?.prompt || '').trim();
}

function getDispatchText(event) {
  return String(event?.body || event?.content || '').trim();
}

function hasExplicitThinkDirective(prompt) {
  const text = String(prompt || '');
  return /\/think(?::|\s+)(off|minimal|low|medium|high|xhigh|adaptive)\b/i.test(text);
}

function stripSystemNoise(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (/^Relevant memory/i.test(line)) return false;
      if (/^Current time:/i.test(line)) return false;
      if (/^Conversation info \(untrusted metadata\):/i.test(line)) return false;
      if (/^Sender \(untrusted metadata\):/i.test(line)) return false;
      if (/^Multi-agent routing decision:/i.test(line)) return false;
      return true;
    })
    .join('\n');
}

function resolveConfigAgentModel(cfg, agentId) {
  const defaults = cfg?.agents?.defaults || {};
  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const found = list.find((item) => String(item?.id || '').trim() === agentId) || null;
  const model = String(found?.model || defaults?.model?.primary || '').trim();
  return {
    model,
    providerModelRef: model,
  };
}

function getRule(ruleSet, key) {
  if (!ruleSet || typeof ruleSet !== 'object' || !key) return null;
  if (ruleSet[key]) return ruleSet[key];
  const target = String(key).toLowerCase();
  for (const [ruleKey, ruleValue] of Object.entries(ruleSet)) {
    const candidate = String(ruleKey || '').toLowerCase();
    if (!candidate) continue;
    if (candidate === target) return ruleValue;
    if (target.includes(candidate)) return ruleValue;
  }
  return null;
}

function autoLevelFromPrompt(prompt, autoPolicy = DEFAULT_AUTO_POLICY) {
  const text = stripSystemNoise(prompt).toLowerCase();
  if (/^只回复\s*(ok|yes|no|状态)?$/.test(text) || /^只返回\s*(ok|yes|no|状态|路径)?$/.test(text) || /只回复ok|只返回ok|只返回 yes|只返回 no|只返回状态/.test(text)) {
    return 'off';
  }
  const planningKeywords = autoPolicy.planningKeywords || DEFAULT_AUTO_POLICY.planningKeywords;
  const implementationKeywords = autoPolicy.implementationKeywords || DEFAULT_AUTO_POLICY.implementationKeywords;
  const simpleKeywords = autoPolicy.simpleKeywords || DEFAULT_AUTO_POLICY.simpleKeywords;
  const reviewKeywords = autoPolicy.reviewKeywords || DEFAULT_AUTO_POLICY.reviewKeywords;
  const researchKeywords = autoPolicy.researchKeywords || DEFAULT_AUTO_POLICY.researchKeywords;

  const score = {
    off: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const keyword of planningKeywords) if (text.includes(String(keyword).toLowerCase())) score.high += 3;
  for (const keyword of reviewKeywords) if (text.includes(String(keyword).toLowerCase())) score.high += 2;
  for (const keyword of researchKeywords) if (text.includes(String(keyword).toLowerCase())) score.high += 2;
  for (const keyword of implementationKeywords) if (text.includes(String(keyword).toLowerCase())) score.medium += 3;
  for (const keyword of simpleKeywords) if (text.includes(String(keyword).toLowerCase())) {
    score.low += 4;
    score.off += 2;
  }

  if (text.length > 1400) score.high += 2;
  if (/只回复|一句话|只要结果|只返回路径|只返回 yes|只返回 no|只返回 ok|只返回状态/.test(text)) {
    score.low += 4;
    score.off += 4;
  }
  if (/json|结构化|字段|schema|表格/.test(text)) score.medium += 2;
  if (/兼容|迁移|排查|性能|瓶颈|根因/.test(text)) score.high += 2;

  if (score.off >= 4 && score.off >= score.low && score.off >= score.medium && score.off >= score.high) return 'off';
  if (score.low >= score.medium && score.low >= score.high) return 'low';
  if (score.high >= score.medium) return 'high';
  return 'medium';
}

function resolveBaseLevel(prompt, globalRule, agentRule, modelRule, autoPolicy) {
  if (agentRule?.mode && normalizeMode(agentRule.mode) !== 'auto') {
    return normalizeLevel(agentRule.level || agentRule.mode, 'low');
  }
  if (modelRule?.mode && normalizeMode(modelRule.mode) !== 'auto') {
    return normalizeLevel(modelRule.level || modelRule.mode, 'low');
  }
  if (globalRule?.mode && normalizeMode(globalRule.mode) !== 'auto') {
    return normalizeLevel(globalRule.level || globalRule.mode, 'low');
  }
  return autoLevelFromPrompt(prompt, autoPolicy);
}

function resolveBound(rule, field) {
  return normalizeLevel(rule?.[field], null);
}

function resolveAllowedLevels(rule) {
  if (!rule || typeof rule !== 'object') return [];
  const only = normalizeLevel(rule.only, null);
  if (only) return [only];
  return normalizeLevelList(rule.allowedLevels);
}

function mergeBounds(globalRule, agentRule, modelRule) {
  const mins = [resolveBound(globalRule, 'minimumLevel'), resolveBound(agentRule, 'minimumLevel'), resolveBound(modelRule, 'minimumLevel')].filter(Boolean);
  const maxs = [resolveBound(globalRule, 'maximumLevel'), resolveBound(agentRule, 'maximumLevel'), resolveBound(modelRule, 'maximumLevel')].filter(Boolean);
  const minLevel = mins.length ? THINK_LEVELS[Math.max(...mins.map(levelIndex))] : null;
  const maxLevel = maxs.length ? THINK_LEVELS[Math.min(...maxs.map(levelIndex))] : null;
  return { minLevel, maxLevel };
}

function mergeAllowedLevels(globalRule, agentRule, modelRule) {
  const sets = [globalRule, agentRule, modelRule]
    .map(resolveAllowedLevels)
    .filter((levels) => levels.length > 0);
  if (!sets.length) return [];
  return sets.reduce((acc, current) => acc.filter((level) => current.includes(level)));
}

function clampToAllowedLevels(level, allowedLevels) {
  if (!Array.isArray(allowedLevels) || allowedLevels.length === 0) return level;
  if (allowedLevels.includes(level)) return level;
  const currentIndex = levelIndex(level);
  const ranked = allowedLevels
    .map((candidate) => ({
      candidate,
      distance: Math.abs(levelIndex(candidate) - currentIndex),
      idx: levelIndex(candidate),
    }))
    .sort((a, b) => a.distance - b.distance || a.idx - b.idx);
  return ranked[0]?.candidate || level;
}

function buildDecision({ prompt, agentId, modelRef, cfg, pluginCfg }) {
  const globalRule = {
    mode: normalizeMode(pluginCfg.defaultMode, 'auto'),
    level: normalizeLevel(pluginCfg.defaultLevel, 'low'),
    minimumLevel: normalizeLevel(pluginCfg.minimumLevel, 'off'),
    maximumLevel: normalizeLevel(pluginCfg.maximumLevel, null),
  };
  const agentRule = getRule(pluginCfg.agentRules, agentId) || {};
  const modelRule = getRule(pluginCfg.modelRules, modelRef) || {};
  const autoPolicy = pluginCfg.autoPolicy || DEFAULT_AUTO_POLICY;
  const baseLevel = resolveBaseLevel(prompt, globalRule, agentRule, modelRule, autoPolicy);
  const { minLevel, maxLevel } = mergeBounds(globalRule, agentRule, modelRule);
  const boundedLevel = clampLevel(baseLevel, minLevel, maxLevel);
  const allowedLevels = mergeAllowedLevels(globalRule, agentRule, modelRule);
  const finalLevel = clampToAllowedLevels(boundedLevel, allowedLevels);
  const conflict = minLevel && maxLevel && levelIndex(minLevel) > levelIndex(maxLevel);
  return {
    agentId,
    modelRef,
    baseLevel,
    boundedLevel,
    finalLevel,
    minLevel,
    maxLevel,
    allowedLevels,
    conflict: Boolean(conflict),
    globalRule,
    agentRule,
    modelRule,
  };
}

async function setSessionThinking(agentId, sessionKey, targetLevel) {
  const storePath = resolveStorePath(undefined, { agentId });
  return updateSessionStore(storePath, (store) => {
    const entry = store?.[sessionKey];
    if (!entry) return { updated: false, reason: 'missing-session-entry' };
    const current = normalizeLevel(entry.thinkingLevel, null);
    if (current === targetLevel) return { updated: false, reason: 'unchanged' };
    entry.thinkingLevel = targetLevel;
    return { updated: true, previous: current, next: targetLevel };
  });
}

function previewFileFor(pluginCfg) {
  const configured = String(pluginCfg.previewFile || '').trim();
  return configured || DEFAULT_PREVIEW;
}

function writePreview(file, payload) {
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

const plugin = {
  register(api) {
    api.logger.info?.('[openclaw-thinking-orchestrator] plugin registered');

    api.registerTool({
      name: 'thinking_orchestrator_status',
      label: 'Thinking Orchestrator Status',
      description: 'Inspect the latest thinking level decision applied by the orchestrator.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const file = previewFileFor(api.pluginConfig || {});
        let details = null;
        try {
          details = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          details = null;
        }
        return {
          content: [{ type: 'text', text: details ? `thinking=${details.finalLevel} agent=${details.agentId} model=${details.modelRef}` : 'no decision yet' }],
          details: { success: true, details },
        };
      },
    });

    api.on('before_dispatch', async (event, ctx) => {
      const pluginCfg = api.pluginConfig || {};
      if (pluginCfg.enabled === false) return;

      const prompt = getDispatchText(event);
      const agentId = String(ctx?.sessionKey || event?.sessionKey || '').match(/^agent:([^:]+):/)?.[1] || 'main';
      const sessionKey = String(ctx?.sessionKey || event?.sessionKey || '').trim();
      if (!prompt || !agentId || !sessionKey) return;

      if (pluginCfg.respectExplicitThinkDirective !== false && hasExplicitThinkDirective(prompt)) {
        const file = previewFileFor(pluginCfg);
        writePreview(file, {
          skipped: true,
          reason: 'explicit-think-directive',
          phase: 'before_dispatch',
          agentId,
          sessionKey,
          at: new Date().toISOString(),
        });
        return;
      }

      const cfg = loadConfig();
      const { providerModelRef } = resolveConfigAgentModel(cfg, agentId);
      const decision = buildDecision({
        prompt,
        agentId,
        modelRef: providerModelRef,
        cfg,
        pluginCfg,
      });
      const result = await setSessionThinking(agentId, sessionKey, decision.finalLevel);
      const file = previewFileFor(pluginCfg);
      writePreview(file, {
        ...decision,
        phase: 'before_dispatch',
        sessionKey,
        sessionUpdate: result,
        at: new Date().toISOString(),
      });
    });

    api.on('before_prompt_build', async (event, ctx) => {
      const pluginCfg = api.pluginConfig || {};
      if (pluginCfg.enabled === false) return;

      const prompt = getPromptText(event);
      const agentId = resolveEventAgentId(event, ctx);
      const sessionKey = String(ctx?.sessionKey || event?.sessionKey || '').trim();
      if (!prompt || !agentId || !sessionKey) return;

      if (pluginCfg.respectExplicitThinkDirective !== false && hasExplicitThinkDirective(prompt)) {
        const file = previewFileFor(pluginCfg);
        writePreview(file, {
          skipped: true,
          reason: 'explicit-think-directive',
          phase: 'before_prompt_build',
          agentId,
          sessionKey,
          at: new Date().toISOString(),
        });
        return;
      }

      const cfg = loadConfig();
      const { providerModelRef } = resolveConfigAgentModel(cfg, agentId);
      const decision = buildDecision({
        prompt,
        agentId,
        modelRef: providerModelRef,
        cfg,
        pluginCfg,
      });

      const result = await setSessionThinking(agentId, sessionKey, decision.finalLevel);
      const file = previewFileFor(pluginCfg);
      writePreview(file, {
        ...decision,
        phase: 'before_prompt_build',
        sessionKey,
        sessionUpdate: result,
        at: new Date().toISOString(),
      });
    });
  },
};

plugin.__private = {
  buildDecision,
};

module.exports = plugin;
