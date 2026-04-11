const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Import dynamic degradation module
const {
  makeDynamicDecision,
  formatDegradeLog,
  DEFAULT_BUDGET_CONFIG,
} = require('./dynamic-degrade.js');

const HOME = os.homedir();
const DEFAULT_PREVIEW = path.join(HOME, '.openclaw', 'workspace', '.openclaw', 'thinking-orchestrator-preview.json');
const DEFAULT_HISTORY = path.join(HOME, '.openclaw', 'workspace', '.openclaw', 'thinking-orchestrator-history.jsonl');
const DEFAULT_BRIEFS_DIR = path.join(HOME, '.openclaw', 'workspace', '.openclaw', 'thinking-orchestrator-briefs');
const DEFAULT_AGENTS_ROOT = path.join(HOME, '.openclaw', 'agents');
const LEVELS = ['off', 'low', 'medium', 'high'];

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(file);
  // Use crypto.randomUUID for unique temp file to avoid collisions
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch (writeErr) {
    // Clean up temp file on failure
    try { fs.unlinkSync(temp); } catch {}
    throw writeErr;
  }
}

function randomId() {
  return crypto.randomBytes(4).toString('hex');
}

function hashText(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function safeSlug(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeLevel(value, fallback = 'low') {
  const normalized = String(value || '').toLowerCase().trim();
  return LEVELS.includes(normalized) ? normalized : fallback;
}

function levelIndex(value) {
  return LEVELS.indexOf(normalizeLevel(value));
}

function clampLevel(level, minimumLevel = 'off', maximumLevel = 'high') {
  const rawIndex = levelIndex(level);
  const minIndex = levelIndex(minimumLevel);
  const maxIndex = levelIndex(maximumLevel);
  const bounded = Math.max(minIndex, Math.min(maxIndex, rawIndex));
  return LEVELS[bounded];
}

function pickMoreIntense(a, b) {
  return levelIndex(a) >= levelIndex(b) ? a : b;
}

function getPromptText(event) {
  return String(event?.prompt || '').trim();
}

function resolveAgentId(event, ctx) {
  const direct = String(event?.agentId || ctx?.agentId || '').trim();
  if (direct) return direct;
  const nested = String(
    event?.agent?.id ||
    event?.agent?.name ||
    event?.context?.agentId ||
    ctx?.agent?.id ||
    ctx?.agent?.name ||
    ''
  ).trim();
  if (nested) return nested;
  const sessionKey = resolveSessionKey(event, ctx);
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] || 'main';
}

function resolveSessionKey(event, ctx) {
  return String(event?.sessionKey || ctx?.sessionKey || event?.session || '').trim();
}

function resolveModelId(event, ctx) {
  return String(
    event?.model ||
    event?.modelId ||
    ctx?.model ||
    ctx?.modelId ||
    ctx?.activeModel ||
    ''
  ).trim();
}

function isInternalControlPrompt(prompt, sessionKey = '') {
  const text = String(prompt || '');
  if (!text) return true;
  const patterns = [
    /^System:/im,
    /^HEARTBEAT(?:_OK)?$/im,
    /Read HEARTBEAT\.md if it exists/im,
    /Current time:/im,
    /\[cron:[^\]]+\]/im,
    /gateway\.restart/im,
    /openclaw doctor --non-interactive/im,
    /Multi-agent routing decision:/im,
    /Execution brief:/im,
    /Search orchestration guidance:/im,
    /Relevant memory \(minimal\):/im,
    /Sender \(untrusted metadata\):/im,
    /Conversation info \(untrusted metadata\):/im,
    /before_agent_start/im,
    /openclaw-control-ui/im,
  ];
  if (patterns.some((pattern) => pattern.test(text))) return true;
  return /:cron:|:heartbeat$|:subagent:/.test(sessionKey);
}

function hasExplicitDirective(prompt) {
  const text = String(prompt || '');
  if (/\b(think hard|deeply think|think deeper|deeper analysis|carefully reason|step by step|systematic analysis)\b/i.test(text)) {
    return 'high';
  }
  if (/\b(quick answer|no need to think|don't overthink|just answer|brief answer only|reply ok only)\b/i.test(text)) {
    return 'off';
  }
  return '';
}

function classifyPrompt(prompt) {
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();
  const reasons = [];

  if (!text) {
    return { level: 'off', kind: 'empty', reasons: ['empty_prompt'] };
  }

  if (/(架构|architecture|设计方案|tradeoff|取舍|review|审查|研究|research|compare|对比|分析|root cause|根因|审计)/i.test(lower)) {
    reasons.push('high_signal_research_or_design');
    return { level: 'high', kind: 'analysis', reasons };
  }

  if (/(实现|implement|fix|修复|debug|测试|test|refactor|重构|编码|写代码|patch)/i.test(lower)) {
    reasons.push('medium_signal_build_work');
    return { level: 'medium', kind: 'build', reasons };
  }

  if (/\n\s*(1\.|- |\* )/.test(text) || /[。.!?]\s+[A-Z\u4e00-\u9fff]/.test(text) || text.length > 500) {
    reasons.push('structured_or_long_prompt');
    return { level: 'medium', kind: 'structured', reasons };
  }

  if (/^(ok|okay|收到|明白|继续|继续做|go on|status|yes|no)[.!]?$/i.test(text) || text.length <= 12) {
    return { level: 'off', kind: 'trivial', reasons: ['trivial_ack'] };
  }

  reasons.push('default_auto_fallback');
  return { level: 'low', kind: 'general', reasons };
}

function detectLanguage(prompt) {
  const text = String(prompt || '');
  const hasZh = /[\u4e00-\u9fff]/.test(text);
  const hasEn = /[a-z]/i.test(text);
  if (hasZh && hasEn) return 'mixed';
  if (hasZh) return 'zh';
  if (hasEn) return 'en';
  return 'unknown';
}

function collectKeywordMatches(text, groups) {
  const found = [];
  for (const [name, pattern] of groups) {
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

function inferRequestedActions(prompt) {
  return collectKeywordMatches(String(prompt || ''), [
    ['analyze', /(分析|analy[sz]e|architecture|设计方案|root cause|根因)/i],
    ['compare', /(compare|对比|tradeoff|取舍)/i],
    ['review', /(review|审查|评审|audit|审计)/i],
    ['implement', /(实现|implement|build|编码|写代码)/i],
    ['fix', /(修复|fix|bug)/i],
    ['debug', /(debug|排查|定位)/i],
    ['test', /(测试|test|spec)/i],
    ['refactor', /(refactor|重构)/i],
    ['summarize', /(总结|summary|summari[sz]e|汇总)/i],
  ]);
}

function inferDeliverables(prompt) {
  return collectKeywordMatches(String(prompt || ''), [
    ['code', /(代码|code|patch|implement|fix|refactor)/i],
    ['tests', /(测试|test|spec)/i],
    ['summary', /(总结|summary|汇总)/i],
    ['report', /(报告|report|review)/i],
    ['json', /(json|结构化|只输出)/i],
    ['plan', /(计划|plan|下一步|todo)/i],
  ]);
}

function inferConstraints(prompt) {
  const lines = String(prompt || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.filter((line) => (
    /^(不要|别|请勿|do not|don't|only|must|只|仅|务必)/i.test(line) ||
    /只输出|不要输出|不创建|不切换|忽略/i.test(line)
  )).slice(0, 8);
}

function buildSafeTaskBrief(prompt, decision) {
  const normalized = String(prompt || '').trim();
  const collapsed = normalizeWhitespace(normalized);
  const firstLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const objective = (firstLine || collapsed).slice(0, 220);
  return {
    objective,
    language: detectLanguage(normalized),
    promptLength: normalized.length,
    workType: decision?.kind || 'general',
    compactionHint: decision?.compactionHint || 'auto',
    requestedActions: inferRequestedActions(normalized),
    deliverables: inferDeliverables(normalized),
    constraints: inferConstraints(normalized),
  };
}

function getCompactionHint(level) {
  switch (normalizeLevel(level, 'low')) {
    case 'off':
    case 'low':
      return 'micro';
    case 'medium':
      return 'auto';
    case 'high':
      return 'full';
    default:
      return 'auto';
  }
}

function applyRule(level, rule = {}) {
  const allowedLevels = Array.isArray(rule?.allowedLevels)
    ? rule.allowedLevels.map((item) => normalizeLevel(item)).filter(Boolean)
    : [];
  let effective = level;
  if (rule?.mode && rule.mode !== 'auto') {
    effective = normalizeLevel(rule.mode, effective);
  }
  effective = clampLevel(
    effective,
    rule?.minimumLevel || 'off',
    rule?.maximumLevel || 'high'
  );
  if (allowedLevels.length && !allowedLevels.includes(effective)) {
    effective = allowedLevels.sort((a, b) => levelIndex(a) - levelIndex(b))[0];
  }
  return effective;
}

function buildDecision(prompt, options = {}) {
  const config = options.config || {};
  const agentId = String(options.agentId || 'main');
  const modelId = String(options.modelId || '');
  const baseMode = String(config.defaultMode || 'auto').trim().toLowerCase();
  const baseLevel = normalizeLevel(config.defaultLevel || 'low', 'low');
  const minimumLevel = normalizeLevel(config.minimumLevel || 'off', 'off');
  const maximumLevel = normalizeLevel(config.maximumLevel || 'high', 'high');
  const explicit = config.respectExplicitThinkDirective === false ? '' : hasExplicitDirective(prompt);
  const promptDecision = classifyPrompt(prompt);

  let level = baseMode === 'auto' ? promptDecision.level : normalizeLevel(baseMode, baseLevel);
  const reasons = [...promptDecision.reasons];
  if (baseMode !== 'auto') reasons.push(`default_mode_${baseMode}`);
  if (explicit) {
    level = explicit;
    reasons.push(`explicit_directive_${explicit}`);
  }

  level = clampLevel(level, minimumLevel, maximumLevel);

  const agentRule = config.agentRules?.[agentId];
  if (agentRule) {
    const next = applyRule(level, agentRule);
    if (next !== level) reasons.push(`agent_rule_${agentId}`);
    level = next;
  }

  const modelRule = config.modelRules?.[modelId];
  if (modelRule) {
    const next = applyRule(level, modelRule);
    if (next !== level) reasons.push(`model_rule_${modelId}`);
    level = next;
  }

  return {
    level,
    compactionHint: getCompactionHint(level),
    agentId,
    modelId,
    kind: promptDecision.kind,
    explicitDirective: explicit || null,
    minimumLevel,
    maximumLevel,
    reasons,
  };
}

function getSessionsRegistryPath(agentId, pluginConfig = {}) {
  const agentsRoot = String(pluginConfig.agentsRoot || DEFAULT_AGENTS_ROOT);
  return path.join(agentsRoot, agentId, 'sessions', 'sessions.json');
}

function getSessionEntry(agentId, sessionKey, pluginConfig = {}) {
  const registryPath = getSessionsRegistryPath(agentId, pluginConfig);
  const registry = readJson(registryPath, {});
  if (!registry || typeof registry !== 'object') {
    return { registryPath, registry: {}, sessionEntry: null };
  }
  return {
    registryPath,
    registry,
    sessionEntry: registry[sessionKey] || null,
  };
}

function getLastJsonlEventId(sessionFile) {
  try {
    const text = fs.readFileSync(sessionFile, 'utf8').trim();
    if (!text) return null;
    const lines = text.split('\n').filter(Boolean);
    if (!lines.length) return null;
    // Safely parse only the last line with try-catch
    let last;
    try {
      last = JSON.parse(lines[lines.length - 1]);
    } catch {
      return null; // Corrupted last line - treat as no valid id
    }
    return last?.id || null;
  } catch {
    return null;
  }
}

function appendThinkingLevelEvent(sessionFile, level) {
  if (!sessionFile) return;
  try {
    ensureDir(sessionFile);
    const event = {
      type: 'thinking_level_change',
      id: randomId(),
      parentId: getLastJsonlEventId(sessionFile),
      timestamp: new Date().toISOString(),
      thinkingLevel: level,
    };
    fs.appendFileSync(sessionFile, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // Best effort only. Session patching should not break dispatch.
  }
}

function patchSessionThinkingLevel(agentId, sessionKey, level, pluginConfig = {}) {
  if (!sessionKey) return { updated: false, reason: 'missing_session_key' };
  const { registryPath, registry, sessionEntry } = getSessionEntry(agentId, sessionKey, pluginConfig);
  if (!sessionEntry) return { updated: false, reason: 'session_not_found', registryPath };
  if (sessionEntry.thinkingLevel === level) {
    return {
      updated: false,
      reason: 'already_set',
      registryPath,
      sessionFile: sessionEntry.sessionFile || null,
    };
  }
  const nextRegistry = { ...registry };
  const nextEntry = {
    ...sessionEntry,
    thinkingLevel: level,
    updatedAt: Date.now(),
  };
  nextRegistry[sessionKey] = nextEntry;
  writeJsonAtomic(registryPath, nextRegistry);
  appendThinkingLevelEvent(nextEntry.sessionFile, level);
  return {
    updated: true,
    registryPath,
    sessionFile: nextEntry.sessionFile || null,
  };
}

function writePreview(pluginConfig, payload) {
  const previewFile = String(pluginConfig.previewFile || DEFAULT_PREVIEW);
  writeJsonAtomic(previewFile, payload);
  return previewFile;
}

function appendHistory(pluginConfig, payload) {
  const historyFile = String(pluginConfig.historyFile || DEFAULT_HISTORY);
  ensureDir(historyFile);
  fs.appendFileSync(historyFile, `${JSON.stringify(payload)}\n`, 'utf8');
  return historyFile;
}

function readRecentHistory(pluginConfig, limit = 10) {
  const historyFile = String(pluginConfig.historyFile || DEFAULT_HISTORY);
  try {
    const text = fs.readFileSync(historyFile, 'utf8').trim();
    if (!text) return [];
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function buildPreviewPayload(event, ctx, pluginConfig, decision, patchResult, skipped) {
  const prompt = getPromptText(event);
  return {
    timestamp: new Date().toISOString(),
    skipped,
    sessionKey: resolveSessionKey(event, ctx),
    agentId: resolveAgentId(event, ctx),
    modelId: resolveModelId(event, ctx),
    promptPreview: prompt.slice(0, 500),
    decision,
    patchResult,
  };
}

function buildHistoryPayload(event, ctx, decision, patchResult, skipped) {
  const prompt = getPromptText(event);
  return {
    timestamp: new Date().toISOString(),
    skipped,
    sessionKey: resolveSessionKey(event, ctx),
    agentId: resolveAgentId(event, ctx),
    modelId: resolveModelId(event, ctx),
    promptHash: crypto.createHash('sha1').update(prompt).digest('hex'),
    promptPreview: prompt.slice(0, 200),
    decision,
    patchResult,
  };
}

function buildBriefArtifactPath(pluginConfig = {}, agentId, sessionKey) {
  const briefsDir = String(pluginConfig.briefsDir || DEFAULT_BRIEFS_DIR);
  const sessionLabel = sessionKey || 'no-session';
  return path.join(
    briefsDir,
    safeSlug(agentId || 'main', 'main'),
    `${safeSlug(sessionLabel)}-${hashText(sessionLabel).slice(0, 10)}.json`
  );
}

function writeBriefArtifact(pluginConfig, event, ctx, decision) {
  const prompt = getPromptText(event);
  const agentId = resolveAgentId(event, ctx);
  const sessionKey = resolveSessionKey(event, ctx);
  const modelId = resolveModelId(event, ctx);
  const artifactPath = buildBriefArtifactPath(pluginConfig, agentId, sessionKey);
  const artifactPayload = {
    version: '1.0',
    kind: 'safe-task-brief',
    generated_at: new Date().toISOString(),
    sessionKey,
    agentId,
    modelId,
    promptHash: hashText(prompt),
    promptPreview: prompt.slice(0, 500),
    decision,
    brief: buildSafeTaskBrief(prompt, decision),
  };
  writeJsonAtomic(artifactPath, artifactPayload);
  return {
    type: 'json',
    kind: 'safe-task-brief',
    version: '1.0',
    path: artifactPath,
    sessionKey,
    agentId,
  };
}

const VERSION = '2.0.1';

const plugin = {
  version: VERSION,

  register(api) {
    api.logger.info?.(`[openclaw-thinking-orchestrator] v${VERSION} plugin registered`);

    api.registerTool({
      name: 'thinking_orchestrator_status',
      label: 'Thinking Orchestrator Status',
      description: 'Read the latest thinking decision preview and current session level.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const preview = readJson(String(api.pluginConfig?.previewFile || DEFAULT_PREVIEW), null);
        return {
          content: [
            {
              type: 'text',
              text: preview
                ? `thinking=${preview?.decision?.level || 'unknown'} agent=${preview?.agentId || 'unknown'} skipped=${Boolean(preview?.skipped)}`
                : 'no thinking preview yet',
            },
          ],
          details: { success: true, preview },
        };
      },
    });

    api.registerTool({
      name: 'thinking_orchestrator_recent',
      label: 'Thinking Orchestrator Recent',
      description: 'Read the recent thinking decisions transcript.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
        required: [],
      },
      execute: async (args = {}) => {
        const limit = Math.max(1, Math.min(20, Number(args?.limit || 5)));
        const history = readRecentHistory(api.pluginConfig || {}, limit);
        return {
          content: [{ type: 'text', text: history.length ? `recent=${history.length}` : 'no thinking history yet' }],
          details: { success: true, history },
        };
      },
    });

    api.registerTool({
      name: 'thinking_orchestrator_analyze',
      label: 'Thinking Orchestrator Analyze',
      description: 'Analyze a prompt and return the safe thinking-level decision.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          agentId: { type: 'string' },
          modelId: { type: 'string' },
        },
        required: ['prompt'],
      },
      execute: async (args = {}) => {
        const prompt = String(args?.prompt || '');
        const decision = buildDecision(prompt, {
          config: api.pluginConfig || {},
          agentId: String(args?.agentId || 'main'),
          modelId: String(args?.modelId || ''),
        });
        return {
          content: [{ type: 'text', text: `thinking=${decision.level} compaction=${decision.compactionHint} kind=${decision.kind}` }],
          details: { success: true, decision },
        };
      },
    });

    api.registerTool({
      name: 'thinking_orchestrator_brief',
      label: 'Thinking Orchestrator Brief',
      description: 'Read the latest safe task brief artifact for a session or agent.',
      parameters: {
        type: 'object',
        properties: {
          sessionKey: { type: 'string' },
          agentId: { type: 'string' },
        },
        required: [],
      },
      execute: async (args = {}) => {
        const agentId = String(args?.agentId || 'main');
        const preview = readJson(String(api.pluginConfig?.previewFile || DEFAULT_PREVIEW), null);
        const requestedSessionKey = String(args?.sessionKey || '');
        const sessionKey = requestedSessionKey || String(preview?.sessionKey || '');
        const artifactPath = buildBriefArtifactPath(api.pluginConfig || {}, agentId, sessionKey);
        const artifact = readJson(artifactPath, null);
        return {
          content: [{
            type: 'text',
            text: artifact
              ? `brief=${artifact.brief?.workType || 'unknown'} level=${artifact.decision?.level || 'unknown'} compaction=${artifact.decision?.compactionHint || artifact.brief?.compactionHint || 'auto'}`
              : 'no task brief yet',
          }],
          details: { success: true, artifact, artifactPath },
        };
      },
    });

    api.on('before_dispatch', async (event, ctx) => {
      if (api.pluginConfig?.enabled === false) return;
      const prompt = getPromptText(event);
      const sessionKey = resolveSessionKey(event, ctx);
      const skipped = isInternalControlPrompt(prompt, sessionKey);
      const agentId = resolveAgentId(event, ctx);
      const modelId = resolveModelId(event, ctx);

      if (skipped) {
        const preview = buildPreviewPayload(event, ctx, api.pluginConfig || {}, null, null, true);
        writePreview(api.pluginConfig || {}, preview);
        appendHistory(api.pluginConfig || {}, buildHistoryPayload(event, ctx, null, null, true));
        return;
      }

      const decision = buildDecision(prompt, {
        config: api.pluginConfig || {},
        agentId,
        modelId,
      });

      // Dynamic degradation: adjust level based on context and complexity
      const remainingTokens = event?.remainingTokens || ctx?.remainingTokens || 999999;
      const dynamicConfig = api.pluginConfig?.dynamicDegrade || {};
      const dynamicDecision = makeDynamicDecision(
        decision.level,
        remainingTokens,
        prompt,
        dynamicConfig
      );

      // Use degraded level if different
      if (dynamicDecision.degraded) {
        decision.level = dynamicDecision.finalLevel;
        decision.reasons.push(`dynamic_degrade:${dynamicDecision.reason}`);
        api.logger.info?.(`[thinking-orchestrator] ${formatDegradeLog(dynamicDecision)}`);
      }

      const patchResult = patchSessionThinkingLevel(agentId, sessionKey, decision.level, api.pluginConfig || {});
      const artifactRef = writeBriefArtifact(api.pluginConfig || {}, event, ctx, decision);
      const preview = {
        ...buildPreviewPayload(event, ctx, api.pluginConfig || {}, decision, patchResult, false),
        artifactRef,
        dynamicDecision, // Include dynamic decision info for debugging
      };
      writePreview(api.pluginConfig || {}, preview);
      appendHistory(api.pluginConfig || {}, {
        ...buildHistoryPayload(event, ctx, decision, patchResult, false),
        artifactRef,
      });
    });
  },
};

module.exports = plugin;
module.exports.VERSION = VERSION;
