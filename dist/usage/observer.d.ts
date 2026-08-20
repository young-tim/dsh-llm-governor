import type { UsageEvent } from './types.js';
/**
 * 最小化的 Stream Chunk 类型。
 *
 * 不依赖 DSH 的具体 chunk 类型，只需识别 usage 和 reason 两个可选字段。
 * type 为任意字符串，observer 不基于 type 做分支。
 */
export interface StreamChunkLike {
    /** Chunk 类型标识（text / usage / finish 等）。 */
    type: string;
    /** Usage 计量。出现时保存 token 计数。 */
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
    };
    /** Finish/错误信息。出现时记录 finish kind 和 failure。 */
    reason?: {
        kind: string;
        failure?: {
            code: string;
            status?: number;
        };
    };
}
/** observeStream 的配置选项。 */
export interface ObserveStreamOptions {
    /** Provider 标识。 */
    provider: string;
    /** 模型标识。 */
    model: string;
    /** DSH Session ID。 */
    sessionId: string;
    /** 当前对话轮次。 */
    turn: number;
    /** 当前步骤序号。 */
    step: number;
    /** 逻辑请求 ID。 */
    requestId: string;
    /** Fallback 序号（0 = 首选）。 */
    fallbackIndex: number;
    /** 治理用户 ID。 */
    userId: string;
    /** 路由模式。 */
    routingMode: string;
    /**
     * 首个语义 chunk（text/reasoning/tool-call delta）已交付回调。
     * 在 fallback.after_partial_output=false 的安全边界中，此后不得再切换模型
     * （§11 透明 Fallback 的安全边界）。幂等：最多调用一次。
     */
    onPartialOutput?: () => void;
}
/**
 * 包装内部流迭代器，观察 usage/finish，不消费或乱序流。
 *
 * 行为保证：
 * - 每个来自 inner 的 chunk 原样 yield 给下游消费者（不消费、不重排序）
 * - 看到 chunk.usage 时保存最新计量（多份 usage chunk 取最后一份）
 * - 看到 chunk.reason 时记录 finish kind 与 failure 信息
 * - 首个语义 chunk 交付时调用 onPartialOutput（幂等，最多一次）
 * - inner 抛错时记录 errorCode，然后重新抛出（不影响下游错误传播）
 * - 在 finally 中调用 onUsage 记录完整事件（无论成功/失败/提前终止）
 *
 * 注意：observer 不会 enrich creditNanos（置 0n），由上游 plugin 根据策略计算。
 * attemptOrigin 固定为 'middleware_or_unknown'，由上游确认 Provider 后修改。
 *
 * @param options 观察配置
 * @param inner 内部流迭代器
 * @param onUsage 事件回调（在 finally 中调用）
 */
export declare function observeStream(options: ObserveStreamOptions, inner: AsyncIterable<StreamChunkLike>, onUsage: (event: UsageEvent) => void): AsyncIterable<StreamChunkLike>;
