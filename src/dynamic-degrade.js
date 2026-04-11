/**
 * Dynamic Thinking Level Degradation
 *
 * 功能：
 * 1. 根据 context 剩余空间自动降级思考级别
 * 2. 根据任务复杂度动态调整
 * 3. 预算控制 - 在 context 不足时限制思考深度
 */

const LEVELS = ['off', 'low', 'medium', 'high'];

function levelIndex(value) {
  return LEVELS.indexOf(value);
}

/**
 * Context 预算配置
 */
const DEFAULT_BUDGET_CONFIG = {
  // 剩余 context 低于此值时开始降级
  contextLowThreshold: 2000,
  // 严重不足阈值，低于此值强制 off
  contextCriticalThreshold: 500,
  // 每次降级的幅度
  degradeStep: 1,
  // 是否在降级时记录原因
  logDegradeReasons: true,
};

/**
 * 复杂度检测配置
 */
const COMPLEXITY_CONFIG = {
  // 触发高复杂度的特征
  highComplexitySignals: [
    /重构|refactor|重写/,
    /架构调整|architecture/,
    /迁移|migration/,
    /调试|debug|根因/,
    /性能优化|performance/,
  ],
  // 触发低复杂度的特征
  lowComplexitySignals: [
    /简单|easy|quick/,
    /只是问|just ask/,
    /不需要|don't need/,
    /brief|short/,
    /ok|okay|好/,
  ],
};

/**
 * 检测任务复杂度
 * @param {string} prompt - 用户 prompt
 * @returns {Object} { level: 'high'|'medium'|'low', reasons: string[] }
 */
function detectComplexity(prompt) {
  const text = String(prompt || '').toLowerCase();
  const reasons = [];

  let complexity = 'medium'; // 默认中等

  for (const signal of COMPLEXITY_CONFIG.highComplexitySignals) {
    if (signal.test(text)) {
      complexity = 'high';
      reasons.push('high_complexity_signal');
      break;
    }
  }

  if (complexity !== 'high') {
    for (const signal of COMPLEXITY_CONFIG.lowComplexitySignals) {
      if (signal.test(text)) {
        complexity = 'low';
        reasons.push('low_complexity_signal');
        break;
      }
    }
  }

  return { level: complexity, reasons };
}

/**
 * 根据 context 状态计算降级后的思考级别
 * @param {string} currentLevel - 当前决定的思考级别
 * @param {number} remainingTokens - 剩余 token 数
 * @param {Object} config - 配置
 * @returns {Object} { level: string, degraded: boolean, reason: string }
 */
function calculateDynamicLevel(currentLevel, remainingTokens, config = {}) {
  const cfg = { ...DEFAULT_BUDGET_CONFIG, ...config };
  const reasons = [];

  // 临界情况 - 强制 off
  if (remainingTokens < cfg.contextCriticalThreshold) {
    return {
      level: 'off',
      degraded: true,
      reason: `context_critical:${remainingTokens}<${cfg.contextCriticalThreshold}`,
    };
  }

  // 正常情况 - 检查是否需要降级
  if (remainingTokens < cfg.contextLowThreshold) {
    const currentIdx = levelIndex(currentLevel);
    if (currentIdx > 0) {
      const newIdx = Math.max(0, currentIdx - cfg.degradeStep);
      const newLevel = LEVELS[newIdx];

      if (newLevel !== currentLevel) {
        reasons.push(`context_low:${remainingTokens}<${cfg.contextLowThreshold}`);
        reasons.push(`degrade:${currentLevel}->${newLevel}`);

        return {
          level: newLevel,
          degraded: true,
          reason: reasons.join(';'),
        };
      }
    }
  }

  return {
    level: currentLevel,
    degraded: false,
    reason: null,
  };
}

/**
 * 根据复杂度调整思考级别
 * @param {string} baseLevel - 基础思考级别
 * @param {Object} complexity - 复杂度检测结果
 * @param {Object} config - 配置
 * @returns {string} 调整后的级别
 */
function adjustForComplexity(baseLevel, complexity, config = {}) {
  const currentIdx = levelIndex(baseLevel);

  if (complexity.level === 'high' && currentIdx < levelIndex('medium')) {
    // 高复杂度任务但思考级别太低，提升
    return 'medium';
  }

  if (complexity.level === 'low' && currentIdx > levelIndex('low')) {
    // 低复杂度任务但思考级别太高，降低
    return 'low';
  }

  return baseLevel;
}

/**
 * 完整的动态思考级别决策
 * @param {string} baseLevel - 基础思考级别
 * @param {number} remainingTokens - 剩余 token
 * @param {string} prompt - 用户 prompt
 * @param {Object} config - 配置
 * @returns {Object} 完整决策结果
 */
function makeDynamicDecision(baseLevel, remainingTokens, prompt, config = {}) {
  // 1. 复杂度检测
  const complexity = detectComplexity(prompt);

  // 2. 复杂度调整
  let level = adjustForComplexity(baseLevel, complexity, config);

  // 3. Context 预算降级
  const budgetResult = calculateDynamicLevel(level, remainingTokens, config);

  return {
    originalLevel: baseLevel,
    afterComplexity: level,
    finalLevel: budgetResult.level,
    degraded: budgetResult.degraded,
    complexity: complexity.level,
    reason: budgetResult.reason || complexity.reasons.join(';') || 'none',
  };
}

/**
 * 创建降级决策的日志摘要
 */
function formatDegradeLog(decision) {
  const lines = [
    `[thinking-degrade] Dynamic level decision:`,
    `  Original: ${decision.originalLevel}`,
    `  After complexity (${decision.complexity}): ${decision.afterComplexity}`,
    `  Final: ${decision.finalLevel}`,
    `  Degraded: ${decision.degraded}`,
    `  Reason: ${decision.reason}`,
  ];
  return lines.join('\n');
}

module.exports = {
  LEVELS,
  DEFAULT_BUDGET_CONFIG,
  COMPLEXITY_CONFIG,
  detectComplexity,
  calculateDynamicLevel,
  adjustForComplexity,
  makeDynamicDecision,
  formatDegradeLog,
};
