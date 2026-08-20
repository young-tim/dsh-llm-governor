/**
 * Governor Cordis 插件：注册事件监听器，将 DSH 事件路由到 Governor 服务。
 * DSH 专属代码只能进入 src/dsh-adapter/ 与 src/plugin/。
 */
import { mkdirSync, readFileSync } from 'node:fs';
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
import type { GovernorPluginConfig, GovernorServiceOptions } from './service.js';
import { observeStream } from '../usage/observer.js';
import type { UsageEvent } from '../usage/types.js';
import { computeCreditNanos } from '../credits/calc.js';
import { GovernorDatabase } from '../storage/database.js';
import { GovernorRepository } from '../storage/repository.js';
import { createGovernorRequestHandler } from '../ui/api.js';
import { resolveConfig } from '../config/index.js';
import type { GovernorConfig, IdentityConfig } from '../config/index.js';
import { HeaderIdentityProvider, JwtIdentityProvider } from '../identity/providers.js';
import type { IdentityProvider } from '../identity/types.js';
import type { LlmClassifierBackend } from '../classifier/index.js';
import type { ClassifyInput, Classification } from '../classifier/index.js';

/** Governor UI 在 DSH webServer 上挂载的前缀。 */
const GOVERNOR_WEB_PREFIX = '/governor';

/** LLM 分类器的 Prompt 版本（与 classifier 缓存键约定一致，变更时 bump）。 */
const CLASSIFIER_PROMPT_VERSION = 'v1';

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
 * 从已验证的 IdentityConfig 构建身份提供者实例（header/jwt 模式）。
 * jwt 密钥优先取 jwt_key_file 文件内容。
 */
function buildIdentityProvider(identity: IdentityConfig): IdentityProvider | undefined {
  if (identity.provider === 'header') {
    return new HeaderIdentityProvider({
      headerName: identity.headerName!,
      trustedProxy: identity.trustedProxy!,
      ...(identity.proxyHeaderName !== undefined
        ? { proxyHeaderName: identity.proxyHeaderName }
        : {}),
      ...(identity.displayNameHeader !== undefined
        ? { displayNameHeader: identity.displayNameHeader }
        : {}),
      ...(identity.emailHeader !== undefined ? { emailHeader: identity.emailHeader } : {}),
    });
  }
  if (identity.provider === 'jwt') {
    const key =
      identity.jwtKeyFile !== undefined
        ? readFileSync(identity.jwtKeyFile, 'utf8')
        : identity.jwtKey!;
    return new JwtIdentityProvider({
      algorithms: identity.jwtAlgorithms!,
      key,
      ...(identity.jwtIssuer !== undefined ? { issuer: identity.jwtIssuer } : {}),
      ...(identity.jwtAudience !== undefined ? { audience: identity.jwtAudience } : {}),
      ...(identity.jwtSubjectClaim !== undefined ? { subjectClaim: identity.jwtSubjectClaim } : {}),
      ...(identity.jwtHeaderName !== undefined ? { headerName: identity.jwtHeaderName } : {}),
      ...(identity.jwtScheme !== undefined ? { scheme: identity.jwtScheme } : {}),
      ...(identity.jwtClockToleranceMs !== undefined
        ? { clockToleranceMs: identity.jwtClockToleranceMs }
        : {}),
    });
  }
  return undefined;
}

/**
 * 构建基于 ctx.llm 的 LLM 分类后端（DSH 特定，只能进入 plugin 层）。
 *
 * 行为（§10.5）：temperature=0、短输出、严格 JSON 解析、超时保护。
 * 非法输出 / 超时 / 网络错误抛错，由 classifier 编排器降级为默认 fallback
 * （confidence=0 → Quality First）。
 */
function createLlmClassifierBackend(
  ctx: Context,
  provider: string,
  model: string,
): LlmClassifierBackend {
  /** 分类 Prompt：要求只输出固定 JSON。 */
  const prompt = [
    'Classify the user task into exactly one task_type from:',
    'general, coding, reasoning, writing, data_analysis, vision, tool_use',
    'and a complexity from: low, medium, high.',
    'Respond with ONLY a JSON object:',
    '{"task_type": "...", "complexity": "...", "confidence": 0.0}',
    `prompt_version: ${CLASSIFIER_PROMPT_VERSION}`,
  ].join('\n');

  /** 解析模型输出为严格 Classification。 */
  function parseClassification(raw: string): Classification {
    // 提取首个 JSON 对象（容忍模型输出前后缀文本）
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('CLASSIFIER_INVALID_JSON');
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      task_type?: string;
      complexity?: string;
      confidence?: number;
    };
    const taskTypes = new Set([
      'general',
      'coding',
      'reasoning',
      'writing',
      'data_analysis',
      'vision',
      'tool_use',
    ]);
    const complexities = new Set(['low', 'medium', 'high']);
    if (typeof obj.task_type !== 'string' || !taskTypes.has(obj.task_type)) {
      throw new Error('CLASSIFIER_INVALID_TASK_TYPE');
    }
    if (typeof obj.complexity !== 'string' || !complexities.has(obj.complexity)) {
      throw new Error('CLASSIFIER_INVALID_COMPLEXITY');
    }
    const confidence =
      typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
        ? Math.min(1, Math.max(0, obj.confidence))
        : 0;
    return {
      taskType: obj.task_type as Classification['taskType'],
      complexity: obj.complexity as Classification['complexity'],
      confidence,
      source: 'llm',
    };
  }

  return {
    async classify(input: ClassifyInput): Promise<Classification> {
      const text = input.messages
        .map((m) => m.text ?? '')
        .join('\n')
        .slice(0, 4000); // 短输出：限制输入规模
      const stream = ctx.llm.stream({
        provider,
        model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: prompt }] },
          { role: 'user', content: [{ type: 'text', text }] },
        ] as never,
        temperature: 0,
        maxTokens: 64,
      } as never);
      let out = '';
      // 超时保护：10s 未完成视为失败
      const deadline = Date.now() + 10_000;
      for await (const chunk of stream as AsyncIterable<{ type: string; text?: string }>) {
        if (Date.now() > deadline) throw new Error('CLASSIFIER_TIMEOUT');
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text;
        }
      }
      return parseClassification(out);
    },
  };
}

/**
 * 将严格 Schema 规范化后的 GovernorConfig 映射回运行时配置形态。
 * 默认值全部来自 Schema 规范化结果，运行时不重复应用默认值。
 */
function toRuntimeConfig(resolved: GovernorConfig): GovernorPluginConfig {
  const models: GovernorPluginConfig['models'] = {};
  for (const [routeId, m] of Object.entries(resolved.models)) {
    models[routeId] = {
      enabled: m.enabled,
      multiplier: m.multiplierPpm / 1_000_000,
      capabilities: [...m.capabilities],
      quality: { ...m.quality },
    };
  }
  const users: GovernorPluginConfig['users'] = {};
  for (const [userId, u] of Object.entries(resolved.users)) {
    users[userId] = {
      allow: [...u.allow],
      monthly_credits: Number(u.monthlyCredits / 1_000_000_000n),
    };
  }
  return {
    models,
    users,
    fallback: {
      enabled: resolved.fallback.enabled,
      max_attempts: resolved.fallback.maxAttempts,
      after_partial_output: resolved.fallback.afterPartialOutput,
    },
    routing: {
      default: resolved.routing.default,
      credit_first: {
        minimum_quality: resolved.routing.creditFirst.minimumQuality,
        on_no_match: resolved.routing.creditFirst.onNoMatch,
      },
    },
    auto: {
      confidence_threshold: resolved.auto.confidenceThreshold,
      quality_threshold: { ...resolved.auto.qualityThreshold },
    },
    credits: {
      tokens_per_credit: resolved.credits.tokensPerCredit,
      timezone: resolved.credits.timezone,
      default_monthly_credits: Number(resolved.credits.defaultMonthlyCredits / 1_000_000_000n),
    },
    identity: {
      provider: resolved.identity.provider,
      ...(resolved.identity.localUserId !== undefined
        ? { local_user_id: resolved.identity.localUserId }
        : {}),
    },
    storage: {
      enabled: resolved.storage.enabled,
      ...(resolved.storage.path !== undefined ? { path: resolved.storage.path } : {}),
    },
    ui: {
      enabled: resolved.ui.enabled,
      ...(resolved.ui.port > 0 ? { port: resolved.ui.port } : {}),
    },
  };
}

/**
 * Governor Cordis 插件入口。
 *
 * - inject llm：模型目录刷新与 LLM 分类器依赖 ctx.llm。
 * - 严格配置校验：apply() 第一行调用 resolveConfig()（fail closed：
 *   未知字段/范围越界/条件必填缺失直接抛错，Cordis 拒绝加载插件）。
 * - 创建 SQLite 仓库（默认 $DSH_HOME/dsh-llm-governor/governor.db，迁移失败 fail closed）。
 * - header/jwt 模式构建 IdentityProvider 实例并暴露 /governor/api/bind 入站绑定端点。
 * - 注册 agent/pre-step、agent/request、llm/stream、agent/request-error 监听器。
 * - UI 挂载：有 ctx.webServer 时注册 /governor 前缀路由，否则按 ui.port 独立监听。
 */
export const GovernorPlugin = {
  name: 'dsh-llm-governor',
  inject: ['llm'],
  async apply(ctx: Context, config: GovernorPluginConfig): Promise<void> {
    // 0. 严格配置校验：未知字段拒绝、范围校验、条件必填。
    //    验证失败抛 ConfigError → 插件加载失败（fail closed）。
    const resolved = resolveConfig(config);
    const runtimeConfig = toRuntimeConfig(resolved);

    // 1. SQLite 仓储：storage.enabled=false 时纯内存运行；
    //    打开或迁移失败时 fail closed（不以空库继续治理与计费）。
    let repository: GovernorRepository | undefined;
    if (runtimeConfig.storage?.enabled !== false) {
      const dbPath = runtimeConfig.storage?.path ?? defaultDbPath();
      if (dbPath !== ':memory:') {
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      }
      const db = new GovernorDatabase(dbPath);
      repository = new GovernorRepository(db);
      const disposeDb = () => db.close();
      ctx.effect(() => disposeDb);
    }

    // 2. 服务构造：注入身份提供者实例与 LLM 分类后端（均来自已验证配置）
    const serviceOptions: GovernorServiceOptions = {};
    const identityProvider = buildIdentityProvider(resolved.identity);
    if (identityProvider !== undefined) {
      serviceOptions.identityProvider = identityProvider;
    }
    if (
      resolved.auto.llmClassifier.enabled &&
      resolved.auto.llmClassifier.provider.length > 0 &&
      resolved.auto.llmClassifier.model.length > 0
    ) {
      serviceOptions.classifierBackend = createLlmClassifierBackend(
        ctx,
        resolved.auto.llmClassifier.provider,
        resolved.auto.llmClassifier.model,
      );
    }
    const service = new GovernorService(ctx, runtimeConfig, repository, serviceOptions);

    // 3. 从 DSH advisory 合并模型目录（初始目录从配置构建，在构造函数中完成）
    try {
      await service.refreshModelDirectory(
        () => ctx.llm.listProviders(),
        (p) => ctx.llm.listModels(p),
      );
    } catch {
      // DSH 未就绪时保留配置构建的初始目录
    }

    // 4. llm/adapters-updated：刷新模型目录
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

    // 5. agent/pre-step：读取本步新消息，执行 Hint/Rule/LLM 自动分类，
    //    并提取能力/模态要求（图片输入 → vision 能力 + image 模态）
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

    // 6. agent/request：读取下游配置，执行准入并返回 provider/model
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

    // 7. llm/stream：观察真实 attempt、Token、finish、时延，不消费流。
    //    首个语义 chunk 交付时标记部分输出保护（此后不再透明切换模型）。
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
            // 部分输出保护接线：首个语义 chunk 交付后禁止透明 Fallback（§11）
            onPartialOutput: () => service.markPartialOutput(sessionId, turn, step),
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

    // 8. agent/request-error：判断失败能否 Fallback，排除失败路由并返回 retry。
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

    // 9. UI 与入站绑定挂载：优先注册到 DSH webServer（受信 Host 面），
    //    无 webServer 且配置了 ui.port 时回退为独立本地服务器。
    const handle = createGovernorRequestHandler(service, {});
    if (runtimeConfig.ui?.enabled !== false) {
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
            void handleGovernorWeb(req, res, service, identityProvider).catch(() => {});
          },
        });
        ctx.effect(() => dispose);
      } else if (runtimeConfig.ui?.port !== undefined) {
        const { createGovernorApiServer } = await import('../ui/api.js');
        const server = createGovernorApiServer(service, {});
        server.listen(runtimeConfig.ui.port, '127.0.0.1');
        ctx.effect(() => () => void server.close(() => {}));
      }
    }

    /**
     * webServer 前缀路由处理器：常规请求交给 API 处理器；
     * POST /api/bind 是 header/jwt 模式的入站身份绑定端点（仅本地回环可信）。
     */
    async function handleGovernorWeb(
      req: unknown,
      res: unknown,
      svc: GovernorService,
      provider: IdentityProvider | undefined,
    ): Promise<void> {
      const request = req as {
        method?: string;
        url?: string;
        headers?: Record<string, string | string[] | undefined>;
        socket?: { remoteAddress?: string };
        on?: (event: string, cb: (chunk: Buffer) => void) => void;
      };
      const response = res as {
        writeHead: (status: number, headers: Record<string, string | number>) => void;
        end: (body?: string) => void;
      };
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname.startsWith(GOVERNOR_WEB_PREFIX)
        ? url.pathname.slice(GOVERNOR_WEB_PREFIX.length) || '/'
        : url.pathname;

      // POST /api/bind：入站身份绑定（header/jwt 模式的真实绑定路径）
      if (path === '/api/bind' && request.method === 'POST') {
        // 仅本地回环可信（companion ingress / 反向代理部署在本机）
        const addr = request.socket?.remoteAddress ?? '';
        const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
        if (!isLoopback) {
          response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'FORBIDDEN', code: 'FORBIDDEN' }));
          return;
        }
        if (provider === undefined) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(
            JSON.stringify({
              error: 'IDENTITY_PROVIDER_NOT_CONFIGURED',
              code: 'IDENTITY_PROVIDER_NOT_CONFIGURED',
            }),
          );
          return;
        }
        // 读取请求体 { sessionId, headers }
        const body = await new Promise<string>((resolve, reject) => {
          let data = '';
          request.on?.('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          request.on?.('end', () => resolve(data));
          request.on?.('error', reject);
        });
        let parsed: { sessionId?: string; headers?: Record<string, string> };
        try {
          parsed = JSON.parse(body || '{}') as {
            sessionId?: string;
            headers?: Record<string, string>;
          };
        } catch {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'INVALID_JSON', code: 'INVALID_JSON' }));
          return;
        }
        if (typeof parsed.sessionId !== 'string' || typeof parsed.headers !== 'object') {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' }));
          return;
        }
        try {
          const identity = await svc.bindIdentityFromHeaders(parsed.sessionId, parsed.headers);
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ userId: identity.userId }));
        } catch (err) {
          const code = err instanceof Error ? err.message : 'IDENTITY_INVALID';
          response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: code, code }));
        }
        return;
      }

      // 其余请求交给通用 API 处理器（剥离 /governor 前缀）
      await handle(request as never, response as never, GOVERNOR_WEB_PREFIX);
    }
  },
};

export default GovernorPlugin;

export type { GovernorPluginConfig };
