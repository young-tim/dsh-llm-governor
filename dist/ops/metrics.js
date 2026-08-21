import { computeCreditNanos } from '../credits/calc.js';
/** 有效样本下限与 usage_missing 阈值。 */
export const METRICS_THRESHOLDS = {
    /** 有效样本少于该值 → 不足以判断。 */
    minSamples: 100,
    /** usage_missing 比例超过该值 → 不足以判断。 */
    maxUsageMissingRatio: 0.05,
};
/**
 * 计算路由效果指标。
 *
 * @param samples - Auto request 样本集合。
 * @param tokensPerCredit - 每 Credit 对应 Token 数。
 * @returns 指标结果。
 */
export function computeRoutingMetrics(samples, tokensPerCredit) {
    const requests = samples.length;
    const attempts = samples.reduce((sum, s) => sum + s.attempts.length, 0);
    const classifierCreditNanos = samples.reduce((sum, s) => sum + s.classifierCreditNanos, 0n);
    // Request Success Rate：至少一个 attempt completed 的 request 数
    const succeeded = samples.filter((s) => s.attempts.some((a) => a.completed)).length;
    const requestSuccessRate = requests > 0 ? succeeded / requests : 0;
    // usage_missing 比例（全部 attempts）
    const missingCount = samples.reduce((sum, s) => sum + s.attempts.filter((a) => a.usageMissing).length, 0);
    const usageMissingRatio = attempts > 0 ? missingCount / attempts : 0;
    // 有效样本：无 usage_missing 的完整 Auto requests
    const validSamples = samples.filter((s) => s.attempts.length > 0 && s.attempts.every((a) => !a.usageMissing));
    const insufficientSample = validSamples.length < METRICS_THRESHOLDS.minSamples ||
        usageMissingRatio > METRICS_THRESHOLDS.maxUsageMissingRatio;
    const result = {
        requests,
        attempts,
        fallbackCount: Math.max(0, attempts - requests),
        classifierCreditNanos,
        requestSuccessRate,
        sampleCount: validSamples.length,
        usageMissingRatio,
        insufficientSample,
    };
    if (insufficientSample) {
        // 有效样本不足：隐藏节省/保留百分比（“不足以判断”）
        return result;
    }
    // Estimated Credit Saving（反事实）：分母 = Σ(观察到的总 tokens × QF multiplier)
    let actualNanos = classifierCreditNanos;
    let counterfactualNanos = 0n;
    let autoQualitySum = 0;
    let qfQualitySum = 0;
    for (const s of validSamples) {
        for (const a of s.attempts) {
            actualNanos += a.creditNanos;
        }
        const totalTokens = s.attempts.reduce((sum, a) => sum + a.totalTokens, 0);
        counterfactualNanos += computeCreditNanos({ inputTokens: totalTokens, outputTokens: 0 }, s.qualityFirstRoute.multiplierPpm, tokensPerCredit);
        autoQualitySum += s.autoRoute.quality;
        qfQualitySum += s.qualityFirstRoute.quality;
    }
    if (counterfactualNanos > 0n) {
        // 1 - actual / counterfactual（BigInt 定点换算，保留 4 位小数）
        const scaled = (actualNanos * 10000n) / counterfactualNanos;
        result.estimatedCreditSaving = Math.max(0, 1 - Number(scaled) / 10_000);
    }
    if (qfQualitySum > 0) {
        result.configuredQualityRetention = autoQualitySum / qfQualitySum;
    }
    return result;
}
/**
 * 从持久化行构造 Auto 样本（分析辅助：按 requestId 聚合 attempts）。
 *
 * @param decisions - Auto 决策行（含候选快照）。
 * @param usages - usage 行。
 * @param modelDirectory - route → { multiplierPpm, quality } 映射。
 * @returns 样本集合。
 */
export function buildSamplesFromRows(decisions, usages, modelDirectory) {
    const byRequest = new Map();
    for (const d of decisions) {
        const list = byRequest.get(d.requestId) ?? [];
        list.push(d);
        byRequest.set(d.requestId, list);
    }
    const samples = [];
    for (const [requestId, decs] of byRequest) {
        const sorted = [...decs].sort((a, b) => a.fallbackIndex - b.fallbackIndex);
        const finalDecision = sorted[sorted.length - 1];
        if (finalDecision === undefined || finalDecision.selectedRoute === undefined)
            continue;
        const autoRoute = modelDirectory.get(finalDecision.selectedRoute);
        if (autoRoute === undefined)
            continue;
        // Quality First 反事实：候选中 quality 最高（平分取低 multiplier）
        const candidates = sorted[0]?.candidates ?? [];
        let qf = candidates[0];
        for (const c of candidates) {
            if (qf === undefined || (c.quality ?? -1) > (qf.quality ?? -1))
                qf = c;
            else if (c.quality === qf.quality && c.multiplierPpm < qf.multiplierPpm)
                qf = c;
        }
        if (qf === undefined)
            continue;
        const qfRoute = modelDirectory.get(qf.routeId);
        if (qfRoute === undefined)
            continue;
        const attempts = usages
            .filter((u) => u.requestId === requestId && u.usageKind !== 'classifier')
            .map((u) => ({
            fallbackIndex: u.fallbackIndex,
            routeId: `${u.provider}:${u.model}`,
            totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens,
            creditNanos: u.creditNanos,
            usageMissing: u.usageMissing,
            completed: u.success,
        }));
        const classifierCreditNanos = usages
            .filter((u) => u.usageKind === 'classifier' && u.parentRequestId === requestId)
            .reduce((sum, u) => sum + u.creditNanos, 0n);
        samples.push({
            requestId,
            finalRoute: finalDecision.selectedRoute,
            attempts,
            classifierCreditNanos,
            qualityFirstRoute: {
                routeId: qf.routeId,
                multiplierPpm: qfRoute.multiplierPpm,
                quality: qfRoute.quality,
            },
            autoRoute: {
                routeId: finalDecision.selectedRoute,
                multiplierPpm: autoRoute.multiplierPpm,
                quality: autoRoute.quality,
            },
        });
    }
    return samples;
}
