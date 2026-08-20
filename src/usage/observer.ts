/**
 * Stream Observer：包装 AsyncIterable，观察 usage/finish，不消费或乱序流。
 *
 * 关键设计（见 docs/TECHNICAL_DESIGN.md §12）：
 * - 用 try/finally 包装内部迭代器，确保无论成功/失败/提前 break 都记录 Usage
 * - 看到 usage chunk 时保存计量；看到 finish 或 throw 时结束 attempt
 * - 不提前消费：每个 chunk 原样 yield 给下游消费者
 * - creditNanos 由上游（plugin）根据策略 enrich，observer 置 0n
 * - attemptOrigin 默认 'middleware_or_unknown'，只有确认到达 Provider 才标记 'provider'
 *
 * 领域层模块：不导入任何 DSH 包。使用 crypto.randomUUID() 和 Date.now()。
 */
import type { RoutingMode } from '../index.js';
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
    failure?: { code: string; status?: number };
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
}

/** 视为成功的 finish kind 集合。 */
const SUCCESS_FINISH_KINDS = new Set(['stop', 'tool-calls']);

/**
 * 包装内部流迭代器，观察 usage/finish，不消费或乱序流。
 *
 * 行为保证：
 * - 每个来自 inner 的 chunk 原样 yield 给下游消费者（不消费、不重排序）
 * - 看到 chunk.usage 时保存最新计量（多份 usage chunk 取最后一份）
 * - 看到 chunk.reason 时记录 finish kind 与 failure 信息
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
export async function* observeStream(
  options: ObserveStreamOptions,
  inner: AsyncIterable<StreamChunkLike>,
  onUsage: (event: UsageEvent) => void,
): AsyncIterable<StreamChunkLike> {
  // 记录流开始时间（首次 .next() 时执行）
  const start = Date.now();

  // 累积的计量状态
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens: number | undefined;
  let usageMissing = true;
  let finishKind: string | undefined;
  let errorCode: string | undefined;
  let httpStatus: number | undefined;
  let thrown = false;

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
      // 原样透传，不消费或乱序
      yield chunk;
    }
  } catch (err) {
    // inner 抛错：记录错误信息后重新抛出，不影响下游错误传播
    thrown = true;
    if (err instanceof Error && err.name) {
      errorCode = err.name;
    }
    throw err;
  } finally {
    // 无论成功/失败/提前终止，都记录 Usage 事件
    const latencyMs = Date.now() - start;
    const success = !thrown && finishKind !== undefined && SUCCESS_FINISH_KINDS.has(finishKind);

    const event: UsageEvent = {
      id: crypto.randomUUID(),
      requestId: options.requestId,
      sessionId: options.sessionId,
      turn: options.turn,
      step: options.step,
      userId: options.userId,
      provider: options.provider,
      model: options.model,
      routingMode: options.routingMode as RoutingMode,
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
