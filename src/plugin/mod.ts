/**
 * Governor Cordis 插件：注册事件监听器，将 DSH 事件路由到 Governor 服务。
 * DSH 专属代码只能进入 src/dsh-adapter/ 与 src/plugin/。
 */
import type { Context } from '../dsh-adapter/mod.js';
import type {
  LlmCallConfig,
  StreamChunk,
  GenerateOptions,
  LlmFailure,
} from '../dsh-adapter/mod.js';
import { GovernorService } from './service.js';
import type { GovernorPluginConfig } from './service.js';
import { observeStream } from '../usage/observer.js';
import type { UsageEvent } from '../usage/types.js';
import { computeCreditNanos } from '../credits/calc.js';

/**
 * Governor Cordis 插件入口。
 * 创建 GovernorService 并注册 agent/pre-step、agent/request、llm/stream、agent/request-error 监听器。
 */
export const GovernorPlugin = {
  name: 'dsh-llm-governor',
  async apply(ctx: Context, config: GovernorPluginConfig): Promise<void> {
    const service = new GovernorService(ctx, config);

    // 从 DSH advisory 合并模型目录（初始目录从配置构建，在构造函数中完成）
    try {
      await service.refreshModelDirectory(
        () => ctx.llm.listProviders(),
        (p) => ctx.llm.listModels(p),
      );
    } catch {
      // DSH 未就绪时保留配置构建的初始目录
    }

    // llm/adapters-updated：刷新模型目录
    ctx.on(
      'llm/adapters-updated' as never,
      (() => {
        void service
          .refreshModelDirectory(
            () => ctx.llm.listProviders(),
            (p) => ctx.llm.listModels(p),
          )
          .catch(() => {});
      }) as never,
      { global: true } as never,
    );

    // agent/pre-step：读取本步消息，可设置分类
    ctx.on(
      'agent/pre-step' as never,
      (async (
        payload: { agent: { id: string }; turn: number; step: number },
        next: () => Promise<unknown>,
      ) => {
        return next();
      }) as never,
      { global: true } as never,
    );

    // agent/request：读取下游配置，执行准入并返回 provider/model
    ctx.on(
      'agent/request' as never,
      (async (
        payload: { agent: { id: string }; turn: number; step: number; signal: AbortSignal },
        next: () => Promise<LlmCallConfig>,
      ) => {
        const sessionId = payload.agent.id;
        const defaultConfig = await next();
        const { config } = service.selectModel(
          sessionId,
          payload.turn,
          payload.step,
          defaultConfig,
        );
        return config;
      }) as never,
      { global: true } as never,
    );

    // llm/stream：观察真实 attempt、Token、finish、时延，不消费流
    ctx.on(
      'llm/stream' as never,
      ((options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
        const inner = next();
        const sessionId = (options.sessionId as string | undefined) ?? 'unknown';
        const ts = service.getCurrentTurnStep(sessionId);
        const turn = ts?.turn ?? 0;
        const step = ts?.step ?? 0;
        const requestId = service.getRequestId(sessionId, turn, step) ?? 'unknown';
        const fallbackIndex = service.getFallbackIndex(sessionId, turn, step);
        const identity = service.getIdentity(sessionId);
        const tokensPerCredit = 1_000_000;

        return observeStream(
          {
            provider: options.provider,
            model: options.model,
            sessionId,
            turn,
            step,
            requestId,
            fallbackIndex,
            userId: identity?.userId ?? 'unknown',
            routingMode: 'manual',
          },
          inner as AsyncIterable<{
            type: string;
            usage?: {
              inputTokens: number;
              outputTokens: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            };
            reason?: { kind: string; failure?: { code: string; status?: number } };
          }>,
          (event: UsageEvent) => {
            // 计算 credits
            const multiplierPpm = 1_000_000; // 默认 1x
            const enriched: UsageEvent = {
              ...event,
              creditNanos: computeCreditNanos(
                {
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  ...(event.cacheReadTokens ? { cacheReadTokens: event.cacheReadTokens } : {}),
                  ...(event.cacheWriteTokens ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
                },
                multiplierPpm,
                tokensPerCredit,
              ),
            };
            service.recordUsage(enriched);
          },
        ) as unknown as AsyncIterable<StreamChunk>;
      }) as never,
      { global: true } as never,
    );

    // agent/request-error：判断失败能否 Fallback，排除失败路由并返回 retry
    ctx.on(
      'agent/request-error' as never,
      (async (
        payload: {
          agent: { id: string };
          turn: number;
          step: number;
          provider: string;
          failure: LlmFailure;
        },
        next: () => Promise<unknown>,
      ) => {
        const sessionId = payload.agent.id;
        const routeId =
          service.getSelectedRoute(sessionId, payload.turn, payload.step) ?? payload.provider;
        const shouldRetry = service.excludeRouteAndCheckRetry(
          sessionId,
          payload.turn,
          payload.step,
          routeId,
          payload.failure,
        );
        if (shouldRetry) {
          return { kind: 'retry' as const };
        }
        return next();
      }) as never,
      { global: true } as never,
    );
  },
};

export type { GovernorPluginConfig };
