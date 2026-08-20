import type { Classification, ClassifyInput, LlmClassifierBackend, ClassifierCache } from './types.js';
export type { Classification, ClassifyInput, LlmClassifierBackend, ClassifierCache, } from './types.js';
export { classifyByHint } from './hint.js';
export { classifyByRule, complexityByLength } from './rule.js';
export { InMemoryClassifierCache } from './cache.js';
export type { InMemoryClassifierCacheOptions } from './cache.js';
/** createClassifier 接收的配置。 */
export interface ClassifierConfig {
    /** 置信度阈值；confidence < 该值时路由层切 Quality First。 */
    confidenceThreshold: number;
    /** 可选 LLM 后端；不提供则跳过 LLM 阶段。 */
    llmBackend?: LlmClassifierBackend;
    /** 可选缓存；不提供则不缓存 LLM 结果。 */
    cache?: ClassifierCache;
}
/** Classifier 实例。 */
export interface Classifier {
    /** 对输入执行分类。 */
    classify(input: ClassifyInput): Promise<Classification>;
}
/**
 * 创建分类器实例。
 *
 * @param config - 配置：置信度阈值、可选 LLM 后端、可选缓存。
 * @returns Classifier 实例，提供 async classify(input)。
 */
export declare function createClassifier(config: ClassifierConfig): Classifier;
