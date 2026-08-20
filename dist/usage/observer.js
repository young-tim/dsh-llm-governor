/** 视为成功的 finish kind 集合。 */
const SUCCESS_FINISH_KINDS = new Set(['stop', 'tool-calls']);
/**
 * 判断 chunk 是否为已交付的语义内容（模型产出已到达消费者）。
 * text/reasoning/tool-call 的 delta 属于语义 chunk；block-start/usage/finish
 * 等控制信号不属于。
 */
function isSemanticDelta(chunk) {
    return (chunk.type === 'text-delta' ||
        chunk.type === 'reasoning-delta' ||
        chunk.type === 'tool-call-delta' ||
        chunk.type === 'tool-call' ||
        chunk.type === 'input-json-delta');
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
export async function* observeStream(options, inner, onUsage) {
    // 记录流开始时间（首次 .next() 时执行）
    const start = Date.now();
    // 累积的计量状态
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens;
    let usageMissing = true;
    let finishKind;
    let errorCode;
    let httpStatus;
    let thrown = false;
    let partialOutputNotified = false;
    try {
        for await (const chunk of inner) {
            // 看到 usage chunk 时保存计量
            if (chunk.usage) {
                usageMissing = false;
                inputTokens = chunk.usage.inputTokens;
                outputTokens = chunk.usage.outputTokens;
                cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
                cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0;
                reasoningTokens = chunk.usage.reasoningTokens;
            }
            // 看到 reason 时记录 finish kind 与 failure
            if (chunk.reason) {
                finishKind = chunk.reason.kind;
                if (chunk.reason.failure) {
                    errorCode = chunk.reason.failure.code;
                    if (chunk.reason.failure.status !== undefined) {
                        httpStatus = chunk.reason.failure.status;
                    }
                }
            }
            // 首个语义 chunk 交付：通知上游标记部分输出保护（幂等）
            if (!partialOutputNotified && isSemanticDelta(chunk)) {
                partialOutputNotified = true;
                options.onPartialOutput?.();
            }
            // 原样透传，不消费或乱序
            yield chunk;
        }
    }
    catch (err) {
        // inner 抛错：记录错误信息后重新抛出，不影响下游错误传播
        thrown = true;
        if (err instanceof Error && err.name) {
            errorCode = err.name;
        }
        throw err;
    }
    finally {
        // 无论成功/失败/提前终止，都记录 Usage 事件
        const latencyMs = Date.now() - start;
        const success = !thrown && finishKind !== undefined && SUCCESS_FINISH_KINDS.has(finishKind);
        const event = {
            id: crypto.randomUUID(),
            requestId: options.requestId,
            sessionId: options.sessionId,
            turn: options.turn,
            step: options.step,
            userId: options.userId,
            provider: options.provider,
            model: options.model,
            routingMode: options.routingMode,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
            creditNanos: 0n,
            success,
            ...(finishKind !== undefined ? { finishKind } : {}),
            ...(errorCode !== undefined ? { errorCode } : {}),
            ...(httpStatus !== undefined ? { httpStatus } : {}),
            latencyMs,
            fallbackIndex: options.fallbackIndex,
            attemptOrigin: 'middleware_or_unknown',
            usageMissing,
            createdAt: new Date().toISOString(),
        };
        onUsage(event);
    }
}
