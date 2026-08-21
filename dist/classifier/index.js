/**
 * Classifier 模块入口与编排器。
 *
 * 分类顺序（来自技术方案 §10.5）：
 *   1. Hint：上下文确定性信号（explicitHint / hasImage / hasToolContext）
 *   2. Rule：代码块 / 错误栈 / SQL / 表格 / 长文等正则规则
 *   3. LLM：调用配置的轻量模型分类（temperature=0，短输出，严格 JSON，超时）
 *
 * 三个阶段都不命中时返回默认 fallback：{ general, medium, 0, 'rule' }。
 * confidence < threshold 时，结果中的 confidence 字段已标记低置信度，
 * 路由层（routeAuto）据此切 Quality First。
 *
 * 缓存仅在 LLM 阶段启用：Hint 与 Rule 是确定性函数，无需缓存。
 * 缓存键由「规范化输入哈希 + classifier route + Prompt 版本 + 配置 revision」拼装，
 * 保证同一输入+配置下 LLM 决策可复用。
 */
import { createHash } from 'node:crypto';
import { classifyByHint } from './hint.js';
import { classifyByRule } from './rule.js';
import { createSingleFlight } from './sqlite-cache.js';
export { classifyByHint } from './hint.js';
export { classifyByRule, complexityByLength } from './rule.js';
export { InMemoryClassifierCache } from './cache.js';
export { SQLiteClassifierCache, createSingleFlight, hmacInputHash, buildClassifierCacheKey, CLASSIFIER_CACHE_TTL_MS, } from './sqlite-cache.js';
/** 默认 fallback 分类结果：低置信度让路由层切 Quality First。 */
const DEFAULT_FALLBACK = {
    taskType: 'general',
    complexity: 'medium',
    confidence: 0,
    source: 'rule',
};
/** Classifier 自身的 route 标识，参与缓存键。 */
const CLASSIFIER_ROUTE = 'default';
/** Classifier Prompt 版本，参与缓存键；Prompt 变更时 bump 此版本使缓存失效。 */
const PROMPT_VERSION = 'v1';
/** 默认 config revision，参与缓存键。 */
const DEFAULT_CONFIG_REVISION = 1;
/**
 * 规范化分类输入（缓存键的输入部分）。
 * @param input - 分类输入。
 * @returns 规范化 JSON 文本。
 */
function canonicalInputOf(input) {
    const normalized = {
        messages: input.messages.map((m) => ({ type: m.type, text: m.text ?? '' })),
        hasImage: input.hasImage ?? false,
        hasToolContext: input.hasToolContext ?? false,
        explicitHint: input.explicitHint ?? '',
    };
    return JSON.stringify(normalized);
}
/**
 * 规范化分类输入并生成 sha256 哈希，用作缓存键的输入部分。
 * @param input - 分类输入。
 * @returns 输入哈希（hex）。
 */
function hashInput(input) {
    return createHash('sha256').update(canonicalInputOf(input)).digest('hex');
}
/**
 * 构造 LLM 阶段的缓存键（旧式；cacheKeyBuilder 存在时优先）。
 *
 * 键组成：inputHash : classifierRoute : promptVersion : configRevision
 * 保证同一输入+配置下决策稳定可复用。
 * @param input - 分类输入。
 * @param configRevision - 当前配置 revision。
 */
function buildCacheKey(input, configRevision) {
    return `${hashInput(input)}:${CLASSIFIER_ROUTE}:${PROMPT_VERSION}:${configRevision}`;
}
/**
 * 创建分类器实例。
 *
 * @param config - 配置：置信度阈值、可选 LLM 后端、可选缓存、缓存键构造器。
 * @returns Classifier 实例，提供 async classify(input)。
 */
export function createClassifier(config) {
    const cache = config.cache;
    const llmBackend = config.llmBackend;
    const cacheKeyBuilder = config.cacheKeyBuilder;
    const configRevisionGetter = config.configRevisionGetter ?? (() => DEFAULT_CONFIG_REVISION);
    // GOV-CLASSIFIER-001：同一缓存键并发请求 single-flight，只产生一次 classifier 调用
    const singleFlight = createSingleFlight();
    return {
        /**
         * 执行分类。
         *
         * 顺序：Hint → Rule → LLM（带缓存 + single-flight）→ 默认 fallback。
         * LLM 抛错或非法输出时降级为默认 fallback；低置信度结果不缓存
         * （GOV-CLASSIFIER-001 AC 3）。
         */
        async classify(input) {
            // 1. Hint：上下文确定性信号
            const hintResult = classifyByHint(input);
            if (hintResult !== undefined)
                return hintResult;
            // 2. Rule：正则规则
            const ruleResult = classifyByRule(input);
            if (ruleResult !== undefined)
                return ruleResult;
            // 3. LLM：轻量模型分类（带缓存 + single-flight）
            if (llmBackend !== undefined) {
                const configRevision = configRevisionGetter();
                const cacheKey = cacheKeyBuilder !== undefined
                    ? cacheKeyBuilder(canonicalInputOf(input), configRevision)
                    : buildCacheKey(input, configRevision);
                if (cache !== undefined) {
                    const cached = cache.get(cacheKey);
                    if (cached !== undefined)
                        return cached;
                }
                const result = await singleFlight.run(cacheKey, async () => {
                    try {
                        const llmResult = await llmBackend.classify(input);
                        // 低置信度结果不缓存（GOV-CLASSIFIER-001 AC 3）
                        if (cache !== undefined && llmResult.confidence >= config.confidenceThreshold) {
                            cache.set(cacheKey, llmResult);
                        }
                        return llmResult;
                    }
                    catch {
                        // 非法输出 / 超时 / 网络错误：降级为默认 fallback，不缓存
                        // confidence=0 < threshold，路由层会切 Quality First
                        return { ...DEFAULT_FALLBACK };
                    }
                });
                return result;
            }
            // 4. 默认 fallback：general, medium, 0, 'rule'
            return { ...DEFAULT_FALLBACK };
        },
    };
}
