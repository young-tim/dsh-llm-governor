/**
 * GOV-OPS-003：路由效果指标（反事实估算，只读）。
 *
 * 公式（优化文档 4.3）：
 * - Estimated Credit Saving =
 *     1 - Σ(实际全部 attempts 与 classifier creditNanos)
 *       / Σ(以观察到的总 tokens × Quality First multiplier 得到的反事实 creditNanos)
 * - Configured Quality Retention =
 *     Σ(Auto 最终 route 的配置 Quality) / Σ(Quality First route 的配置 Quality)
 *   ——必须标为“配置分值估算”，不能表述为真实回答质量。
 * - Request Success Rate = 至少一个 attempt completed 的 request 数 / request 总数。
 * - 有效样本少于 100 个或 usage_missing > 5% 时显示“不足以判断”
 *   （insufficientSample=true，隐藏节省/保留百分比）。
 */
import type { DecisionQueryResult, UsageEventRow } from '../storage/repository.js';
/** 有效样本下限与 usage_missing 阈值。 */
export declare const METRICS_THRESHOLDS: {
    /** 有效样本少于该值 → 不足以判断。 */
    readonly minSamples: 100;
    /** usage_missing 比例超过该值 → 不足以判断。 */
    readonly maxUsageMissingRatio: 0.05;
};
/** 指标输入：一次 Auto request 的观察数据。 */
export interface AutoRequestSample {
    requestId: string;
    /** Auto 最终选中 route（至少一个 attempt completed 的最终 route）。 */
    finalRoute: string;
    /** 该 request 全部 conversation attempts 的 usage。 */
    attempts: ReadonlyArray<{
        fallbackIndex: number;
        routeId: string;
        totalTokens: number;
        creditNanos: bigint;
        usageMissing: boolean;
        completed: boolean;
    }>;
    /** 关联的 classifier usage（creditNanos 之和）。 */
    classifierCreditNanos: bigint;
    /** 候选快照中 Quality First 将选择的 route 及其 multiplier/quality。 */
    qualityFirstRoute: {
        routeId: string;
        multiplierPpm: number;
        quality: number;
    };
    /** Auto 最终 route 的 multiplier 与配置 quality。 */
    autoRoute: {
        routeId: string;
        multiplierPpm: number;
        quality: number;
    };
}
/** 指标结果。 */
export interface RoutingMetrics {
    /** Requests 与 Attempts 双分母。 */
    requests: number;
    attempts: number;
    /** Fallback 数量（attempts - requests，近似）。 */
    fallbackCount: number;
    /** classifier 成本（creditNanos）。 */
    classifierCreditNanos: bigint;
    /** Request 成功率（0-1）。 */
    requestSuccessRate: number;
    /** 估算节省比例（0-1）；不足以判断时省略。 */
    estimatedCreditSaving?: number;
    /** 配置分值保留比例（0-1）；不足以判断时省略。 */
    configuredQualityRetention?: number;
    /** 有效样本数。 */
    sampleCount: number;
    /** usage_missing 比例（0-1）。 */
    usageMissingRatio: number;
    /** 有效样本不足或 usage_missing 超阈值时为 true（隐藏百分比）。 */
    insufficientSample: boolean;
}
/**
 * 计算路由效果指标。
 *
 * @param samples - Auto request 样本集合。
 * @param tokensPerCredit - 每 Credit 对应 Token 数。
 * @returns 指标结果。
 */
export declare function computeRoutingMetrics(samples: readonly AutoRequestSample[], tokensPerCredit: number): RoutingMetrics;
/**
 * 从持久化行构造 Auto 样本（分析辅助：按 requestId 聚合 attempts）。
 *
 * @param decisions - Auto 决策行（含候选快照）。
 * @param usages - usage 行。
 * @param modelDirectory - route → { multiplierPpm, quality } 映射。
 * @returns 样本集合。
 */
export declare function buildSamplesFromRows(decisions: readonly DecisionQueryResult[], usages: readonly UsageEventRow[], modelDirectory: ReadonlyMap<string, {
    multiplierPpm: number;
    quality: number;
}>): AutoRequestSample[];
