/**
 * 计算延迟数组的 P95 百分位。
 *
 * 使用 nearest-rank 方法：取第 ceil(n * 0.95) 个值（1-based）。
 * 数组为空时返回 0。
 *
 * @param latencies 延迟数组（无需预排序）
 */
function computeP95(latencies) {
    if (latencies.length === 0)
        return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    // P95 索引：ceil(n * 0.95) - 1（0-based），下界 0
    const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[index] ?? 0;
}
/**
 * 构造空的统计结果。
 *
 * 每次返回新对象，避免共享可变引用。
 */
function emptyStats() {
    return {
        requestCount: 0,
        attemptCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalRawTokens: 0,
        totalCreditNanos: 0n,
        avgCreditNanos: 0,
        successCount: 0,
        successRate: 0,
        fallbackCount: 0,
        fallbackRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        modelDistribution: {},
    };
}
/**
 * Usage 内存聚合器。
 *
 * 通过 Map 维护事件，以 (request_id, fallback_index) 为唯一键实现幂等。
 * 提供按用户、模型、路由维度的统计查询。
 */
export class UsageAggregator {
    /** 事件存储：key = "requestId:fallbackIndex"，value = UsageEvent。 */
    _events = new Map();
    /**
     * 记录事件（幂等）。
     *
     * 重复的 (request_id, fallback_index) 被忽略，保证不双计费。
     */
    record(event) {
        const key = `${event.requestId}:${event.fallbackIndex}`;
        if (this._events.has(key))
            return;
        this._events.set(key, event);
    }
    /**
     * 查询用户统计。
     *
     * 聚合该用户所有 attempt 的 Raw Tokens、Credits、Requests、模型分布。
     */
    queryByUser(userId) {
        const events = [...this._events.values()].filter((e) => e.userId === userId);
        return this._computeStats(events);
    }
    /**
     * 查询模型统计。
     *
     * 聚合指定 provider+model 的 Requests、Tokens、Credits、Success Rate、Latency、Fallback Rate。
     */
    queryByModel(provider, model) {
        const events = [...this._events.values()].filter((e) => e.provider === provider && e.model === model);
        return this._computeStats(events);
    }
    /**
     * 查询路由模式统计。
     *
     * 聚合指定 routing_mode 的请求量、平均 Credits、成功率。
     */
    queryByRouting(mode) {
        const events = [...this._events.values()].filter((e) => e.routingMode === mode);
        return this._computeStats(events);
    }
    /**
     * 列出事件（可选过滤）。
     *
     * 按 userId 和/或 provider 过滤。未提供过滤条件时返回全部事件。
     * 返回顺序为插入顺序（Map 迭代序）。
     */
    listEvents(filter) {
        const events = [...this._events.values()];
        return events.filter((e) => {
            if (filter?.userId !== undefined && e.userId !== filter.userId) {
                return false;
            }
            if (filter?.provider !== undefined && e.provider !== filter.provider) {
                return false;
            }
            return true;
        });
    }
    /**
     * 从事件列表计算统计聚合。
     *
     * 内部方法：遍历事件，累加各项计量，计算成功率和 P95 延迟。
     */
    _computeStats(events) {
        const attemptCount = events.length;
        if (attemptCount === 0)
            return emptyStats();
        const requestIds = new Set();
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let reasoningTokens = 0;
        let totalCreditNanos = 0n;
        let successCount = 0;
        let fallbackCount = 0;
        let totalLatencyMs = 0;
        const latencies = [];
        const modelDist = {};
        for (const e of events) {
            requestIds.add(e.requestId);
            inputTokens += e.inputTokens;
            outputTokens += e.outputTokens;
            cacheReadTokens += e.cacheReadTokens;
            cacheWriteTokens += e.cacheWriteTokens;
            if (e.reasoningTokens !== undefined) {
                reasoningTokens += e.reasoningTokens;
            }
            totalCreditNanos += e.creditNanos;
            if (e.success)
                successCount++;
            if (e.fallbackIndex > 0)
                fallbackCount++;
            totalLatencyMs += e.latencyMs;
            latencies.push(e.latencyMs);
            const key = `${e.provider}/${e.model}`;
            modelDist[key] = (modelDist[key] ?? 0) + 1;
        }
        // reasoningTokens 是 outputTokens 的子集，不重复计入 raw tokens
        const totalRawTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
        return {
            requestCount: requestIds.size,
            attemptCount,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningTokens,
            totalRawTokens,
            totalCreditNanos,
            avgCreditNanos: Number(totalCreditNanos) / attemptCount,
            successCount,
            successRate: successCount / attemptCount,
            fallbackCount,
            fallbackRate: fallbackCount / attemptCount,
            avgLatencyMs: totalLatencyMs / attemptCount,
            p95LatencyMs: computeP95(latencies),
            modelDistribution: modelDist,
        };
    }
}
