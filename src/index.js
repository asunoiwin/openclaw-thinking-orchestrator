const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let runtime = {};
try {
  runtime = require('/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/config-runtime.js');
} catch {
  runtime = {};
}

const {
  loadConfig = () => ({}),
  resolveStorePath = () => null,
  updateSessionStore = async () => ({ updated: false, reason: 'runtime-unavailable' }),
} = runtime;

const DEFAULT_AUTO_POLICY = require('./default-auto-policy.json');

const HOME = os.homedir();
const WORKSPACE = path.join(HOME, '.openclaw', 'workspace', '.openclaw');
const DEFAULT_THINKING_PREVIEW = path.join(WORKSPACE, 'thinking-orchestrator-preview.json');
const DEFAULT_GOAL_PREVIEW = path.join(WORKSPACE, 'goal-compiler-preview.json');
const THINK_LEVELS = ['off', 'low', 'medium', 'high'];
const SUPPORTED_LEVELS = new Set(['off', 'low', 'medium', 'high', 'auto']);

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writeJson(file, value) {
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
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

function resolveSessionKey(event, ctx) {
  return String(ctx?.sessionKey || event?.sessionKey || event?.session || '').trim();
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

function shouldSkipGoal(prompt) {
  if (!prompt) return true;
  if (/\[Subagent Context\]|\[Subagent Task\]:|^# Role:/m.test(prompt)) return true;
  if (/^\[cron:[^\]]+\]/m.test(prompt)) return true;
  if (/^System:/m.test(prompt)) return true;
  if (/你是任务巡检员|你是每日任务汇总助手|你是多 agent 编排调度器/.test(prompt)) return true;
  if (isInternalControlPayload(prompt)) return true;
  return false;
}

function linesOf(prompt) {
  return String(prompt || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripInternalControlBlocks(text) {
  let cleaned = String(text || '');
  const blockPatterns = [
    /(?:^|\n)Multi-agent routing decision:[\s\S]*?(?=\n(?:Sender \(untrusted metadata\):|Conversation info \(untrusted metadata\):|Relevant memory:|Current time:|Read HEARTBEAT\.md|When reading HEARTBEAT\.md|$))/gi,
    /(?:^|\n)Execution brief:[\s\S]*?(?=\n(?:Search orchestration guidance:|Sender \(untrusted metadata\):|Conversation info \(untrusted metadata\):|Relevant memory:|Current time:|Read HEARTBEAT\.md|When reading HEARTBEAT\.md|$))/gi,
    /(?:^|\n)Search orchestration guidance:[\s\S]*?(?=\n(?:Sender \(untrusted metadata\):|Conversation info \(untrusted metadata\):|Relevant memory:|Current time:|Read HEARTBEAT\.md|When reading HEARTBEAT\.md|$))/gi,
  ];
  for (const pattern of blockPatterns) {
    cleaned = cleaned.replace(pattern, '\n');
  }
  return cleaned;
}

function isInternalControlPayload(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (/^System:/mi.test(normalized)) return true;
  if (/Sender \(untrusted metadata\):[\s\S]*openclaw-control-ui/i.test(normalized)) return true;
  if (/^Multi-agent routing decision:/mi.test(normalized)) return true;
  if (/^Execution brief:/mi.test(normalized)) return true;
  if (/^Search orchestration guidance:/mi.test(normalized)) return true;
  return false;
}

function stripSystemNoise(text) {
  return stripInternalControlBlocks(String(text || ''))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (/^Relevant memory/i.test(line)) return false;
      if (/^Current time:/i.test(line)) return false;
      if (/^System:/i.test(line)) return false;
      if (/^Read HEARTBEAT\.md/i.test(line)) return false;
      if (/^Conversation info \(untrusted metadata\):/i.test(line)) return false;
      if (/^Sender \(untrusted metadata\):/i.test(line)) return false;
      if (/^Multi-agent routing decision:/i.test(line)) return false;
      if (/^HEARTBEAT$/i.test(line)) return false;
      if (/^Tool output/i.test(line)) return false;
      return true;
    })
    .join('\n');
}

function extractPaths(text) {
  const matches = String(text).match(/\/Users\/[^\s"'`]+/g) || [];
  return [...new Set(matches)].slice(0, 6);
}

function scoreLine(line) {
  let score = 0;
  if (/不要|不能|禁止|只要|只需|只返回|必须|优先|直接|闭环|不要停/.test(line)) score += 3;
  if (/报告|文档|表格|方案|总结|脚本|插件|仓库|测试|验收|输出|保存|生成/.test(line)) score += 2;
  if (/写到|放到|路径|桌面|workspace|markdown|md|xlsx|csv|json/.test(line)) score += 2;
  return score;
}

function extractDeliverable(lines) {
  const ranked = [...lines]
    .sort((a, b) => scoreLine(b) - scoreLine(a))
    .filter((line) => scoreLine(line) > 0);
  return ranked[0] || lines[0] || '';
}

function extractConstraints(lines, maxConstraints) {
  const picked = [];
  for (const line of lines) {
    if (/不要|不能|禁止|只要|只需|只返回|必须|优先|直接|闭环|不要停/.test(line)) picked.push(line);
    if (picked.length >= maxConstraints) break;
  }
  return picked;
}

function classifyTask(text) {
  if (/clawhub|skill|skills|插件|plugin|github|仓库搜索|找技能|find-skills/i.test(text)) return 'skill_discovery';
  if (/小红书|抖音|知乎|reddit|rebbit|google|百度|github|clawhub|官网|文档/.test(text)) return 'search';
  if (/调研|专利|亚马逊|卖家精灵|竞品|评论|关键词|舆情|商品/.test(text)) return 'research';
  if (/修复|报错|bug|异常|故障|泄漏|污染|不工作/.test(text)) return 'fix';
  if (/搜索|查找|检索|搜一下|看看/.test(text)) return 'search';
  if (/总结|报告|文档|方案|表格|汇总/.test(text)) return 'report';
  return 'general';
}

function buildSearchPlan(text) {
  const plan = [];
  if (/clawhub|skill|skills|插件|plugin|github|找技能|find-skills/i.test(text)) {
    plan.push('先区分是找 OpenClaw skill、插件仓库，还是安装现成能力，不要走泛搜索。');
    plan.push('优先检查本地已安装 skills 和 ClawHub，再补 GitHub 搜索与仓库 README。');
    plan.push('输出时要区分：可直接安装、需要手动接入、仅供参考 三类结果。');
    return plan.slice(0, 3);
  }
  if (/社媒|微博|小红书|抖音|b站|知乎/.test(text)) {
    plan.push('先选平台，再生成结构化证据卡，不直接堆网页结果。');
  }
  if (/淘宝|京东|拼多多|闲鱼|得物|美团|携程|亚马逊/.test(text)) {
    plan.push('商品/电商检索优先保留价格、销量、店铺、评价和筛选条件。');
  }
  if (/专利/.test(text)) {
    plan.push('专利检索优先保留专利号、申请人、法律状态和相似点。');
  }
  if (!plan.length) plan.push('先明确待验证结论，再按来源优先级检索并保留证据。');
  return plan.slice(0, 3);
}

function buildExecutionPlan(goal) {
  const steps = [];
  steps.push(`确认交付物：${goal.deliverable || '按用户最后要求收口'}`);
  if (goal.taskKind === 'skill_discovery') {
    steps.push('先检查本地已安装技能与 ClawHub，再补 GitHub 仓库证据。');
  }
  if (goal.taskKind === 'search' || goal.taskKind === 'research') {
    steps.push('先建立结构化证据集，再分析和汇总。');
  }
  if (goal.searchPlan?.length) steps.push(`检索策略：${goal.searchPlan.join('；')}`);
  steps.push('完成后对照目标和约束做自检。');
  return steps.slice(0, 4);
}

function compileGoal(prompt, maxConstraints = 6) {
  const cleanedText = stripSystemNoise(prompt);
  const cleanedLines = linesOf(cleanedText);
  const deliverable = extractDeliverable(cleanedLines);
  const constraints = extractConstraints(cleanedLines, maxConstraints);
  const outputPaths = extractPaths(cleanedText);
  const taskKind = classifyTask(cleanedText);
  const searchPlan = buildSearchPlan(cleanedText);
  return {
    generatedAt: new Date().toISOString(),
    taskKind,
    deliverable,
    constraints,
    outputPaths,
    searchPlan,
    executionPlan: buildExecutionPlan({ taskKind, deliverable, searchPlan }),
    promptPreview: cleanedText.slice(0, 500),
  };
}

function formatExecutionBrief(goal) {
  const lines = [
    'Execution brief:',
    `- 任务类型：${goal.taskKind}`,
    `- 目标：${goal.deliverable || '按用户最后要求收口'}`,
  ];
  if (goal.constraints.length) lines.push(`- 约束：${goal.constraints.join(' | ')}`);
  if (goal.outputPaths.length) lines.push(`- 输出路径：${goal.outputPaths.join(' | ')}`);
  if (goal.searchPlan.length) lines.push(`- 检索策略：${goal.searchPlan.join(' | ')}`);
  if (goal.taskKind === 'search' || goal.taskKind === 'research' || goal.taskKind === 'skill_discovery') {
    lines.push('- 优先工具：websearch_pro_research -> websearch_pro_extract');
  }
  for (const step of goal.executionPlan || []) lines.push(`- 步骤：${step}`);
  return lines.join('\n');
}

function promptFingerprint(goal) {
  return JSON.stringify({
    taskKind: goal.taskKind,
    deliverable: goal.deliverable,
    constraints: goal.constraints,
    outputPaths: goal.outputPaths,
  });
}

function isGoalInjectionEnabled(pluginConfig = {}) {
  if (pluginConfig.enabled === false) return false;
  if (pluginConfig.injectBeforePromptBuild === false) return false;
  if (pluginConfig.injectGoalBrief === false) return false;
  return true;
}

function previewFileFor(pluginCfg) {
  const configured = String(pluginCfg.previewFile || '').trim();
  return configured || DEFAULT_THINKING_PREVIEW;
}

function goalPreviewFileFor(pluginCfg) {
  const configured = String(pluginCfg.goalPreviewFile || '').trim();
  return configured || DEFAULT_GOAL_PREVIEW;
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
  if (Object.prototype.hasOwnProperty.call(ruleSet, key)) return ruleSet[key];
  const target = String(key).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ruleSet, target)) return ruleSet[target];
  for (const [ruleKey, ruleValue] of Object.entries(ruleSet)) {
    const candidate = String(ruleKey || '').toLowerCase();
    if (!candidate) continue;
    if (candidate === target) return ruleValue;
    if (candidate === '*' || candidate === 'default' || candidate === 'other') return ruleValue;
    if (candidate.endsWith('*')) {
      const prefix = candidate.slice(0, -1);
      if (prefix && target.startsWith(prefix)) return ruleValue;
    }
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
  const score = { off: 0, high: 0, medium: 0, low: 0 };
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
  if (agentRule?.mode && normalizeMode(agentRule.mode) !== 'auto') return normalizeLevel(agentRule.level || agentRule.mode, 'low');
  if (modelRule?.mode && normalizeMode(modelRule.mode) !== 'auto') return normalizeLevel(modelRule.level || modelRule.mode, 'low');
  if (globalRule?.mode && normalizeMode(globalRule.mode) !== 'auto') return normalizeLevel(globalRule.level || globalRule.mode, 'low');
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
  const sets = [globalRule, agentRule, modelRule].map(resolveAllowedLevels).filter((levels) => levels.length > 0);
  if (!sets.length) return [];
  return sets.reduce((acc, current) => acc.filter((level) => current.includes(level)));
}

function clampToAllowedLevels(level, allowedLevels) {
  if (!Array.isArray(allowedLevels) || !allowedLevels.length) return level;
  if (allowedLevels.includes(level)) return level;
  const currentIndex = levelIndex(level);
  const ranked = allowedLevels
    .map((candidate) => ({ candidate, distance: Math.abs(levelIndex(candidate) - currentIndex), idx: levelIndex(candidate) }))
    .sort((a, b) => a.distance - b.distance || a.idx - b.idx);
  return ranked[0]?.candidate || level;
}

function buildDecision({ prompt, agentId, modelRef, pluginCfg }) {
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
  return {
    agentId,
    modelRef,
    baseLevel,
    boundedLevel,
    finalLevel,
    minLevel,
    maxLevel,
    allowedLevels,
    globalRule,
    agentRule,
    modelRule,
  };
}

async function setSessionThinking(agentId, sessionKey, targetLevel) {
  try {
    const storePath = resolveStorePath(undefined, { agentId });
    if (!storePath) return { updated: false, reason: 'missing-store-path' };
    return await updateSessionStore(storePath, (store) => {
      const entry = store?.[sessionKey];
      if (!entry) return { updated: false, reason: 'missing-session-entry' };
      const current = normalizeLevel(entry.thinkingLevel, null);
      if (current === targetLevel) return { updated: false, reason: 'unchanged' };
      entry.thinkingLevel = targetLevel;
      return { updated: true, previous: current, next: targetLevel };
    });
  } catch (error) {
    return { updated: false, reason: 'update-failed', error: error.message };
  }
}

async function applyThinkingDecision(event, ctx, pluginCfg, phase, prompt) {
  const agentId = resolveEventAgentId(event, ctx);
  const sessionKey = resolveSessionKey(event, ctx);
  if (!prompt || !agentId || !sessionKey) return null;
  if (pluginCfg.respectExplicitThinkDirective !== false && hasExplicitThinkDirective(prompt)) {
    const skipped = {
      skipped: true,
      reason: 'explicit-think-directive',
      phase,
      agentId,
      sessionKey,
      at: new Date().toISOString(),
    };
    writeJson(previewFileFor(pluginCfg), skipped);
    return skipped;
  }
  const cfg = loadConfig();
  const { providerModelRef } = resolveConfigAgentModel(cfg, agentId);
  const decision = buildDecision({
    prompt,
    agentId,
    modelRef: providerModelRef,
    pluginCfg,
  });
  const result = await setSessionThinking(agentId, sessionKey, decision.finalLevel);
  const preview = {
    ...decision,
    phase,
    sessionKey,
    sessionUpdate: result,
    at: new Date().toISOString(),
  };
  writeJson(previewFileFor(pluginCfg), preview);
  return preview;
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
        const details = readJson(file, null);
        return {
          content: [{ type: 'text', text: details ? `thinking=${details.finalLevel || details.reason} agent=${details.agentId || 'main'}` : 'no decision yet' }],
          details: { success: true, details },
        };
      },
    });

    api.registerTool({
      name: 'goal_compiler_status',
      label: 'Goal Compiler Status',
      description: 'Inspect the latest compiled execution brief managed by the merged orchestrator.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const details = readJson(goalPreviewFileFor(api.pluginConfig || {}), null);
        return {
          content: [{ type: 'text', text: details ? `goal=${details.goal?.taskKind || 'general'} agent=${details.agentId || 'main'}` : 'no goal preview yet' }],
          details: { success: true, details },
        };
      },
    });

    api.on('before_dispatch', async (event, ctx) => {
      const pluginCfg = api.pluginConfig || {};
      if (pluginCfg.enabled === false) return;
      const prompt = getDispatchText(event);
      await applyThinkingDecision(event, ctx, pluginCfg, 'before_dispatch', prompt);
    });

    api.on('before_prompt_build', async (event, ctx) => {
      const pluginCfg = api.pluginConfig || {};
      if (pluginCfg.enabled === false) return;

      const prompt = getPromptText(event);
      await applyThinkingDecision(event, ctx, pluginCfg, 'before_prompt_build', prompt);

      if (!isGoalInjectionEnabled(pluginCfg)) return;
      const agentId = resolveEventAgentId(event, ctx);
      if (agentId !== 'main') return;
      const sessionKey = resolveSessionKey(event, ctx);
      if (!sessionKey || shouldSkipGoal(prompt)) return;

      const goal = compileGoal(prompt, Number(pluginCfg.goalMaxConstraints || 6));
      writeJson(goalPreviewFileFor(pluginCfg), {
        generatedAt: new Date().toISOString(),
        agentId,
        sessionKey,
        phase: 'plan-execute-report',
        fingerprint: promptFingerprint(goal),
        goal,
      });
      return {
        prependContext: formatExecutionBrief(goal),
      };
    });
  },
};

plugin.__private = {
  buildDecision,
  compileGoal,
  formatExecutionBrief,
  promptFingerprint,
  isGoalInjectionEnabled,
  stripInternalControlBlocks,
  isInternalControlPayload,
};

module.exports = plugin;
