/**
 * Governor Cordis 插件：注册事件监听器，将 DSH 事件路由到 Governor 服务。
 * DSH 专属代码只能进入 src/dsh-adapter/ 与 src/plugin/。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { GovernorDatabase } from '../storage/database.js';
import { GovernorRepository } from '../storage/repository.js';
import { createGovernorRequestHandler } from '../ui/api.js';

/** Governor UI 在 DSH webServer 上挂载的前缀。 */
const GOVERNOR_WEB_PREFIX = '/governor';

/**
 * 解析默认 SQLite 路径：$DSH_HOME/dsh-llm-governor/governor.db。
 * DSH_HOME 未设置时回退到 ~/.dsh（与 dsh-home-paths 的默认一致）。
 */
function defaultDbPath(): string {
  const dshHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
  return join(dshHome, 'dsh-llm-governor', 'governor.db');
}

/**
 * 从消息 content blocks 中提取纯文本与图片信号（用于 pre-step 分类）。
 * 只读取分类所需的叶子字段，不复制整个内部对象。
 */
function extractClassifyInput(messages: readonly unknown[]): {
  messages: Array<{ type: string; text: string }>;
  hasImage: boolean;
  hasToolContext: boolean;
} {
  let hasImage = false;
  let hasToolContext = false;
  const out: Array<{ type: string; text: string }> = [];
  for (const m of messages) {
    const msg = m as { role?: string; content?: ReadonlyArray<{ type?: string; text?: string }> };
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    let text = '';
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') text += b.text + '\n';
      if (b.type === 'image') hasImage = true;
      if (b.type === 'tool-call' || b.type === 'tool-result') hasToolContext = true;
    }
    out.push({ type: msg.role ?? 'user', text });
  }
  return { messages: out, hasImage, hasToolContext };
}

/**
 * Governor Cordis 插件入口。
 *
 * - inject llm：模型目录刷新依赖 ctx.llm（advisory 合并）。
 * - 创建 SQLite 仓库（默认 $DSH_HOME/dsh-llm-governor/governor.db，迁移失败 fail closed）。
 * - 注册 agent/pre-step、agent/request、llm/stream、agent/request-error 监听器。
 * - UI 挂载：有 ctx.webServer 时注册 /governor 前缀路由，否则按 ui.port 独立监听。
 */
export const GovernorPlugin = {
  name: 'dsh-llm-governor',
  inject: ['llm'],
  async apply(ctx: Context, config: GovernorPluginConfig): Promise<void> {
    // 1. SQLite 仓储：storage.enabled=false 时纯内存运行；
    //    打开或迁移失败时 fail closed（不以空库继续治理与计费）。
    let repository: GovernorRepository | undefined;
    if (config.storage?.enabled !== false) {
      const dbPath = config.storage?.path ?? defaultDbPath();
      if (dbPath !== ':memory:') {
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      }
      const db = new GovernorDatabase(dbPath);
      repository = new GovernorRepository(db);
      const disposeDb = () => db.close();
      ctx.effect(() => disposeDb);
    }

    const service = new GovernorService(ctx, config, repository);

    // 2. 从 DSH advisory 合并模型目录（初始目录从配置构建，在构造函数中完成）
    try {
      await service.refreshModelDirectory(
        () => ctx.llm.listProviders(),
        (p) => ctx.llm.listModels(p),
      );
    } catch {
      // DSH 未就绪时保留配置构建的初始目录
    }

    // 3. llm/adapters-updated：刷新模型目录
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

    // 4. agent/pre-step：读取本步新消息，执行 Hint/Rule 自动分类并缓存到请求状态
    ctx.on(
      'agent/pre-step' as never,
      (async (
        payload: {
          agent: { id: string };
          messages?: ReadonlyArray<{
            role?: string;
            content?: ReadonlyArray<{ type?: string; text?: string }>;
          }>;
          turn: number;
          step: number;
        },
        next: () => Promise<unknown>,
      ) => {
        const sessionId = payload.agent.id;
        const input = extractClassifyInput((payload.messages ?? []) as readonly unknown[]);
        await service.classifyStep(sessionId, payload.turn, payload.step, input);
        return next();
      }) as never,
      { global: true } as never,
    );

    // 5. agent/request：读取下游配置，执行准入并返回 provider/model
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

    // 6. llm/stream：观察真实 attempt、Token、finish、时延，不消费流
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
        // 计费参数与路由模式来自服务配置，不再硬编码
        const tokensPerCredit = service.tokensPerCredit;
        const multiplierPpm = service.getMultiplierPpm(options.provider, options.model);
        const routingMode = service.getRoutingMode(sessionId, turn, step);

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
            routingMode,
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
            // 按模型策略倍率计算 credits
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

    // 7. agent/request-error：判断失败能否 Fallback，排除失败路由并返回 retry。
    //    Recovery Owner 唯一性由 bundle 组合保证（cordis.patch.yml 禁用基础 llm-retry）。
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

    // 8. UI 挂载：优先注册到 DSH webServer（受信 Host 面），
    //    无 webServer 且配置了 ui.port 时回退为独立本地服务器。
    if (config.ui?.enabled !== false) {
      const handle = createGovernorRequestHandler(service, {});
      const webServer = (
        ctx as unknown as {
          get?: (name: string) =>
            | {
                register: (route: {
                  kind: 'prefix';
                  path: string;
                  handler: (req: never, res: never) => void;
                }) => () => void;
              }
            | undefined;
        }
      ).get?.('webServer');
      if (webServer !== undefined) {
        const dispose = webServer.register({
          kind: 'prefix',
          path: GOVERNOR_WEB_PREFIX,
          handler: (req: never, res: never) => {
            void handle(req, res, GOVERNOR_WEB_PREFIX).catch(() => {});
          },
        });
        ctx.effect(() => dispose);
      } else if (config.ui?.port !== undefined) {
        const { createGovernorApiServer } = await import('../ui/api.js');
        const server = createGovernorApiServer(service, {});
        server.listen(config.ui.port, '127.0.0.1');
        ctx.effect(() => () => void server.close(() => {}));
      }
    }
  },
};

export default GovernorPlugin;

export type { GovernorPluginConfig };
