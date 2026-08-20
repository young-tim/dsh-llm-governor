/**
 * Usage 内存聚合器：记录事件并提供统计查询。
 *
 * 关键设计（见 docs/TECHNICAL_DESIGN.md §12）：
 * - record 幂等：唯一键 (request_id, fallback_index) 保证不双计费
 * - 统计维度：User（Raw Tokens、Credits、Requests、模型分布）、
 *   Model（Requests、Tokens、Credits、Success Rate、Latency、Fallback Rate）、
 *   Routing（请求量、平均 Credits、成功率）
 * - 逻辑 Requests 用 distinct request_id，实际 Attempts 用行数
 *
 * 领域层模块：不导入任何 DSH 包。纯内存实现，不涉及持久化。
 */
import type { UsageEvent, UsageStats } from './types.js';
/**
 * Usage 内存聚合器。
 *
 * 通过 Map 维护事件，以 (request_id, fallback_index) 为唯一键实现幂等。
 * 提供按用户、模型、路由维度的统计查询。
 */
export declare class UsageAggregator {
    /** 事件存储：key = "requestId:fallbackIndex"，value = UsageEvent。 */
    private readonly _events;
    /**
     * 记录事件（幂等）。
     *
     * 重复的 (request_id, fallback_index) 被忽略，保证不双计费。
     */
    record(event: UsageEvent): void;
    /**
     * 查询用户统计。
     *
     * 聚合该用户所有 attempt 的 Raw Tokens、Credits、Requests、模型分布。
     */
    queryByUser(userId: string): UsageStats;
    /**
     * 查询模型统计。
     *
     * 聚合指定 provider+model 的 Requests、Tokens、Credits、Success Rate、Latency、Fallback Rate。
     */
    queryByModel(provider: string, model: string): UsageStats;
    /**
     * 查询路由模式统计。
     *
     * 聚合指定 routing_mode 的请求量、平均 Credits、成功率。
     */
    queryByRouting(mode: string): UsageStats;
    /**
     * 列出事件（可选过滤）。
     *
     * 按 userId 和/或 provider 过滤。未提供过滤条件时返回全部事件。
     * 返回顺序为插入顺序（Map 迭代序）。
     */
    listEvents(filter?: {
        userId?: string;
        provider?: string;
    }): UsageEvent[];
    /**
     * 从事件列表计算统计聚合。
     *
     * 内部方法：遍历事件，累加各项计量，计算成功率和 P95 延迟。
     */
    private _computeStats;
}
