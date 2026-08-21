import type { Classification, ClassifyInput, LlmClassifierBackend, ClassifierCache } from './types.js';
export type { Classification, ClassifyInput, LlmClassifierBackend, ClassifierCache, } from './types.js';
export { classifyByHint } from './hint.js';
export { classifyByRule, complexityByLength } from './rule.js';
export { InMemoryClassifierCache } from './cache.js';
export type { InMemoryClassifierCacheOptions } from './cache.js';
export { SQLiteClassifierCache, createSingleFlight, hmacInputHash, buildClassifierCacheKey, CLASSIFIER_CACHE_TTL_MS, } from './sqlite-cache.js';
/** createClassifier 接收的配置。 */
export interface ClassifierConfig {
    /** 置信度阈值；confidence < 该值时路由层切 Quality First。 */
    confidenceThreshold: number;
    /** 可选 LLM 后端；不提供则跳过 LLM 阶段。 */
    llmBackend?: LlmClassifierBackend;
    /** 可选缓存；不提供则不缓存 LLM 结果。 */
    cache?: ClassifierCache;
    /**
     * 缓存键构造器（GOV-CLASSIFIER-001：HMAC 键 + route + promptVersion +
     * configRevision + tenantScope）。提供时优先使用；否则用旧式 sha256 键。
     */
    cacheKeyBuilder?: (canonicalInput: string, configRevision: number) => string;
    /** 当前配置 revision 的读取器（缓存键组成；缺省为 1）。 */
    configRevisionGetter?: () => number;
}
/** Classifier 实例。 */
export interface Classifier {
    /** 对输入执行分类。 */
    classify(input: ClassifyInput): Promise<Classification>;
}
/**
 * 创建分类器实例。
 *
 * @param config - 配置：置信度阈值、可选 LLM 后端、可选缓存、缓存键构造器。
 * @returns Classifier 实例，提供 async classify(input)。
 */
export declare function createClassifier(config: ClassifierConfig): Classifier;
