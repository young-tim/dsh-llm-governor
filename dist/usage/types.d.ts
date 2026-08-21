/**
 * Usage 模块类型定义。
 *
 * 关键语义（见 docs/TECHNICAL_DESIGN.md §12）：
 * - 一条 Usage 对应一次下游 ctx.llm attempt，不是一次逻辑用户请求
 * - 字段 creditNanos 以 bigint 存储，避免精度损失
 * - reasoningTokens 是 outputTokens 的子集，不重复累计
 * - attempt_origin 区分 provider 直连与 middleware 短路，统计不伪称已发生 Provider HTTP
 *
 * 领域层模块：不导入任何 DSH 包。
 */
import type { RoutingMode, TaskType } from '../index.js';
/** Attempt 来源标识。只有确认到达 Provider 才标记 'provider'。 */
export type AttemptOrigin = 'provider' | 'middleware_or_unknown';
/** GOV-USAGE-001：用量种类（用户对话成本 vs 路由分类成本）。 */
export type UsageKind = 'conversation' | 'classifier';
/**
 * 完整的 Usage 事件。
 *
 * 唯一键 (requestId, fallbackIndex) 保证重复 Session 事件和进程恢复不双计费。
 * createdAt 使用 ISO 8601 字符串（SQLite TEXT 兼容）。
 */
export interface UsageEvent {
    /** 事件唯一 ID。 */
    id: string;
    /** 逻辑请求 ID。同一 request_id 可能有多个 fallback attempt。 */
    requestId: string;
    /** DSH Session ID。 */
    sessionId: string;
    /** 用量种类：conversation（用户对话）或 classifier（路由分类，GOV-USAGE-001）。 */
    usageKind?: UsageKind;
    /** classifier 用量关联的父 requestId（分类器是父请求的辅助调用）。 */
    parentRequestId?: string;
    /** 当前对话轮次。 */
    turn: number;
    /** 当前步骤序号。 */
    step: number;
    /** 治理用户 ID。 */
    userId: string;
    /** Provider 标识。 */
    provider: string;
    /** 模型标识。 */
    model: string;
    /** 路由模式。 */
    routingMode: RoutingMode;
    /** 任务分类类型。 */
    taskType?: TaskType;
    /** 输入 Token 数。 */
    inputTokens: number;
    /** 输出 Token 数（含 reasoning 子集）。 */
    outputTokens: number;
    /** 缓存读取 Token 数。 */
    cacheReadTokens: number;
    /** 缓存写入 Token 数。 */
    cacheWriteTokens: number;
    /** 推理 Token 数（outputTokens 的子集，不重复累计）。 */
    reasoningTokens?: number;
    /** Credit 计量（nanos）。由上游根据策略 enrich。 */
    creditNanos: bigint;
    /** 是否成功（finish kind 为 stop 或 tool-calls）。 */
    success: boolean;
    /** Finish kind（stop / tool-calls / length / content-filter 等）。 */
    finishKind?: string;
    /** 错误码。 */
    errorCode?: string;
    /** HTTP 状态码。 */
    httpStatus?: number;
    /** 延迟（毫秒，从流开始到结束）。 */
    latencyMs: number;
    /** Fallback 序号（0 = 首选，>0 = 重试）。 */
    fallbackIndex: number;
    /** Attempt 来源。 */
    attemptOrigin: AttemptOrigin;
    /** 是否缺少 usage chunk（Provider 未返回计量）。 */
    usageMissing: boolean;
    /** 创建时间（ISO 8601）。 */
    createdAt: string;
}
/**
 * 统计聚合结果。
 *
 * 覆盖三个维度的统计需求：
 * - User：Raw Tokens、Credits、Requests、模型分布
 * - Model：Requests、Tokens、Credits、Success Rate、Latency、Fallback Rate
 * - Routing：请求量、平均 Credits、成功率
 *
 * 逻辑 Requests 用 distinct request_id 计数，实际 Attempts 用行数。
 */
export interface UsageStats {
    /** 逻辑请求数（distinct request_id）。 */
    requestCount: number;
    /** 实际 attempt 数（行数）。 */
    attemptCount: number;
    /** 总输入 Token 数。 */
    inputTokens: number;
    /** 总输出 Token 数。 */
    outputTokens: number;
    /** 总缓存读取 Token 数。 */
    cacheReadTokens: number;
    /** 总缓存写入 Token 数。 */
    cacheWriteTokens: number;
    /** 总推理 Token 数（outputTokens 子集）。 */
    reasoningTokens: number;
    /** Raw Tokens = input + output + cache_read + cache_write。 */
    totalRawTokens: number;
    /** 总 Credit（nanos）。 */
    totalCreditNanos: bigint;
    /** 平均 Credit（nanos），attemptCount=0 时为 0。 */
    avgCreditNanos: number;
    /** 成功 attempt 数。 */
    successCount: number;
    /** 成功率（0..1），attemptCount=0 时为 0。 */
    successRate: number;
    /** Fallback attempt 数（fallbackIndex > 0）。 */
    fallbackCount: number;
    /** Fallback 率（0..1），attemptCount=0 时为 0。 */
    fallbackRate: number;
    /** 平均延迟（ms），attemptCount=0 时为 0。 */
    avgLatencyMs: number;
    /** P95 延迟（ms），attemptCount=0 时为 0。 */
    p95LatencyMs: number;
    /** 模型分布：key 为 "provider/model"，value 为 attempt 数。 */
    modelDistribution: Readonly<Record<string, number>>;
}
