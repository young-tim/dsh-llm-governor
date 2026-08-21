/**
 * Governor Cordis 插件：注册事件监听器，将 DSH 事件路由到 Governor 服务。
 * DSH 专属代码只能进入 src/dsh-adapter/ 与 src/plugin/。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GovernorService } from './service.js';
import { uuidv7 } from '../routing/decision.js';
import { observeStream } from '../usage/observer.js';
import { computeCreditNanos } from '../credits/calc.js';
import { GovernorDatabase } from '../storage/database.js';
import { GovernorRepository } from '../storage/repository.js';
import { createGovernorRequestHandler } from '../ui/api.js';
import { resolveConfig } from '../config/index.js';
import { HeaderIdentityProvider, JwtIdentityProvider } from '../identity/providers.js';
import { SessionStoreSink, NullSessionEventSink } from './audit-pipeline.js';
import { GovernorRemoteService } from './remote-service.js';
import { localOwnerPrincipal } from '../security/governor-capabilities.js';
export { GovernorExtensionRegistry } from '../extensions/registry.js';
/** Governor UI 在 DSH webServer 上挂载的前缀。 */
const GOVERNOR_WEB_PREFIX = '/governor';
/** LLM 分类器的 Prompt 版本（与 classifier 缓存键约定一致，变更时 bump）。 */
const CLASSIFIER_PROMPT_VERSION = 'v1';
/**
 * 解析默认 SQLite 路径：$DSH_HOME/dsh-llm-governor/governor.db。
 * DSH_HOME 未设置时回退到 ~/.dsh（与 dsh-home-paths 的默认一致）。
 */
function defaultDbPath() {
    const dshHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    return join(dshHome, 'dsh-llm-governor', 'governor.db');
}
/**
 * 从消息 content blocks 中提取纯文本与图片信号（用于 pre-step 分类）。
 * 只读取分类所需的叶子字段，不复制整个内部对象。
 */
function extractClassifyInput(messages) {
    let hasImage = false;
    let hasToolContext = false;
    const out = [];
    for (const m of messages) {
        const msg = m;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        let text = '';
        for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string')
                text += b.text + '\n';
            if (b.type === 'image')
                hasImage = true;
            if (b.type === 'tool-call' || b.type === 'tool-result')
                hasToolContext = true;
        }
        out.push({ type: msg.role ?? 'user', text });
    }
    return { messages: out, hasImage, hasToolContext };
}
/**
 * 从已验证的 IdentityConfig 构建身份提供者实例（header/jwt 模式）。
 * jwt 密钥优先取 jwt_key_file 文件内容。
 */
function buildIdentityProvider(identity) {
    if (identity.provider === 'header') {
        return new HeaderIdentityProvider({
            headerName: identity.headerName,
            trustedProxy: identity.trustedProxy,
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
        const key = identity.jwtKeyFile !== undefined
            ? readFileSync(identity.jwtKeyFile, 'utf8')
            : identity.jwtKey;
        return new JwtIdentityProvider({
            algorithms: identity.jwtAlgorithms,
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
 * 超时是整体预算（默认 10s）：每次等待下一个 chunk 都与剩余时间竞速，
 * 因此流一直不返回首个 chunk 也不会永久等待。
 * 非法输出 / 超时 / 网络错误抛错，由 classifier 编排器降级为默认 fallback
 * （confidence=0 → Quality First）。
 */
function createLlmClassifierBackend(ctx, provider, model, timeoutMs = 10_000) {
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
    function parseClassification(raw) {
        // 提取首个 JSON 对象（容忍模型输出前后缀文本）
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start)
            throw new Error('CLASSIFIER_INVALID_JSON');
        const obj = JSON.parse(raw.slice(start, end + 1));
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
        const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
            ? Math.min(1, Math.max(0, obj.confidence))
            : 0;
        return {
            taskType: obj.task_type,
            complexity: obj.complexity,
            confidence,
            source: 'llm',
        };
    }
    return {
        async classify(input) {
            const text = input.messages
                .map((m) => m.text ?? '')
                .join('\n')
                .slice(0, 4000); // 短输出：限制输入规模
            const stream = ctx.llm.stream({
                provider,
                model,
                // GOV-USAGE-001：分类器调用携带标记 sessionId，llm/stream 观察者据此
                // 将 usage 记为 classifier 用量（不占用 conversation 的 fallbackIndex）。
                sessionId: `governor-classifier:${uuidv7()}`,
                messages: [
                    { role: 'system', content: [{ type: 'text', text: prompt }] },
                    { role: 'user', content: [{ type: 'text', text }] },
                ],
                temperature: 0,
                maxTokens: 64,
            });
            const iterator = stream[Symbol.asyncIterator]();
            let out = '';
            // 整体超时预算：等待每个 chunk 都与剩余时间竞速（含首个 chunk）
            const deadline = Date.now() + timeoutMs;
            try {
                while (true) {
                    const remaining = deadline - Date.now();
                    if (remaining <= 0)
                        throw new Error('CLASSIFIER_TIMEOUT');
                    let timer;
                    try {
                        const next = await Promise.race([
                            iterator.next(),
                            new Promise((_, reject) => {
                                timer = setTimeout(() => reject(new Error('CLASSIFIER_TIMEOUT')), remaining);
                            }),
                        ]);
                        if (next.done)
                            break;
                        if (next.value.type === 'text-delta' && typeof next.value.text === 'string') {
                            out += next.value.text;
                        }
                    }
                    finally {
                        if (timer !== undefined)
                            clearTimeout(timer);
                    }
                }
            }
            catch (err) {
                // 超时/失败时尽力关闭底层流（不 await：挂起的生成器可能永不完成）
                try {
                    const closed = iterator.return?.();
                    if (closed !== undefined)
                        void closed.then(() => { }, () => { });
                }
                catch {
                    // 关闭失败不影响错误传播
                }
                throw err;
            }
            return parseClassification(out);
        },
    };
}
/**
 * 将严格 Schema 规范化后的 GovernorConfig 映射回运行时配置形态。
 * 默认值全部来自 Schema 规范化结果，运行时不重复应用默认值。
 */
function toRuntimeConfig(resolved) {
    const models = {};
    for (const [routeId, m] of Object.entries(resolved.models)) {
        models[routeId] = {
            enabled: m.enabled,
            multiplier: m.multiplierPpm / 1_000_000,
            capabilities: [...m.capabilities],
            quality: { ...m.quality },
        };
    }
    const users = {};
    for (const [userId, u] of Object.entries(resolved.users)) {
        users[userId] = {
            allow: [...u.allow],
            monthly_credits: Number(u.monthlyCredits / 1000000000n),
        };
    }
    return {
        models,
        users,
        fallback: {
            enabled: resolved.fallback.enabled,
            max_attempts: resolved.fallback.maxAttempts,
            after_partial_output: resolved.fallback.afterPartialOutput,
            strategy: resolved.fallback.strategy,
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
            default_monthly_credits: Number(resolved.credits.defaultMonthlyCredits / 1000000000n),
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
        ...(resolved.compatApi !== undefined
            ? {
                compatApi: {
                    enabled: resolved.compatApi.enabled,
                    ...(resolved.compatApi.port !== undefined ? { port: resolved.compatApi.port } : {}),
                    ...(resolved.compatApi.listen !== undefined
                        ? { listen: resolved.compatApi.listen }
                        : {}),
                    ...(resolved.compatApi.token !== undefined ? { token: resolved.compatApi.token } : {}),
                    ...(resolved.compatApi.allowedOrigin !== undefined
                        ? { allowedOrigin: resolved.compatApi.allowedOrigin }
                        : {}),
                },
            }
            : {}),
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
 * - UI 挂载：有 ctx.webServer 时注册 /governor 兼容前缀；独立监听仅在显式启用
 *   compatApi 时启动，默认不新增 socket。
 */
/**
 * 事件接线：把 Governor service 挂到 DSH 事件瀑布（pre-step/request/stream/
 * request-error/session 生命周期），并执行启动对账。
 *
 * 从 apply 提取为独立导出函数：测试可以自组环境（LlmRuntime + FakeAdapter +
 * SessionStore + 自定义 repository/sink 注入故障）后复用同一接线合同。
 *
 * @param ctx - Cordis 上下文。
 * @param service - 已构造的 Governor 服务实例。
 */
export async function wireGovernorEvents(ctx, service) {
    // 4. llm/adapters-updated：刷新模型目录
    ctx.on('llm/adapters-updated', (() => {
        void service
            .refreshModelDirectory(() => ctx.llm.listProviders(), (p) => ctx.llm.listModels(p))
            .catch(() => { });
    }), { global: true });
    // 5. agent/pre-step：读取本步新消息，执行 Hint/Rule/LLM 自动分类，
    //    并提取能力/模态要求（图片输入 → vision 能力 + image 模态）
    ctx.on('agent/pre-step', (async (payload, next) => {
        const sessionId = payload.agent.id;
        const input = extractClassifyInput((payload.messages ?? []));
        await service.classifyStep(sessionId, payload.turn, payload.step, input);
        return next();
    }), { global: true });
    // 6. agent/request：读取下游配置，执行准入并返回 provider/model。
    //    决策双写协议（pending → Session Event → committed）完成后才返回；
    //    审计失败时 fail closed（AUDIT_PERSIST_FAILED），不产生 Provider 调用。
    ctx.on('agent/request', (async (payload, next) => {
        const sessionId = payload.agent.id;
        const defaultConfig = await next();
        const { config } = await service.selectModel(sessionId, payload.turn, payload.step, defaultConfig);
        return config;
    }), { global: true });
    // 7. llm/stream：观察真实 attempt、Token、finish、时延，不消费流。
    //    首个语义 chunk 交付时标记部分输出保护（此后不再透明切换模型）。
    //    attempt 生命周期：调用边界前记录 dispatch_started，结束时收敛 terminal。
    //    GOV-USAGE-001：sessionId 以 governor-classifier: 开头的调用记为
    //    classifier 用量（关联父 request，不占 conversation fallbackIndex）。
    ctx.on('llm/stream', ((options, next) => {
        const inner = next();
        const sessionId = options.sessionId ?? 'unknown';
        const isClassifierCall = sessionId.startsWith('governor-classifier:');
        if (isClassifierCall) {
            // 分类器调用：观察 usage 但不进入请求状态机（独立 requestId 关联父请求）
            const parentId = service.getCurrentParentRequestId(sessionId);
            return observeStream({
                provider: options.provider,
                model: options.model,
                sessionId,
                turn: 0,
                step: 0,
                requestId: sessionId.slice('governor-classifier:'.length),
                fallbackIndex: 0,
                userId: service.getIdentity(sessionId.slice('governor-classifier:'.length))?.userId ??
                    'unknown',
                routingMode: 'auto',
            }, inner, (event) => {
                const enriched = {
                    ...event,
                    usageKind: 'classifier',
                    ...(parentId !== undefined ? { parentRequestId: parentId } : {}),
                    creditNanos: computeCreditNanos({
                        inputTokens: event.inputTokens,
                        outputTokens: event.outputTokens,
                        ...(event.cacheReadTokens ? { cacheReadTokens: event.cacheReadTokens } : {}),
                        ...(event.cacheWriteTokens ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
                    }, service.getMultiplierPpm(options.provider, options.model), service.tokensPerCredit),
                };
                service.recordUsage(enriched);
            });
        }
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
        // Provider 调用边界前记录 dispatch_started（GOV-ATTEMPT-001 AC 1）
        service.markDispatchStarted(sessionId, turn, step);
        return observeStream({
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
        }, inner, (event) => {
            // 按模型策略倍率计算 credits
            const enriched = {
                ...event,
                creditNanos: computeCreditNanos({
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    ...(event.cacheReadTokens ? { cacheReadTokens: event.cacheReadTokens } : {}),
                    ...(event.cacheWriteTokens ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
                }, multiplierPpm, tokensPerCredit),
            };
            service.recordUsage(enriched);
            // attempt 收敛 terminal 状态（completed/failed；重复回调幂等）
            service.markAttemptTerminal(sessionId, turn, step, enriched.success ? 'completed' : 'failed');
        });
    }), { global: true });
    // 8. agent/request-error：判断失败能否 Fallback，排除失败路由并返回 retry。
    //    Recovery Owner 唯一性由 bundle 组合保证（cordis.patch.yml 禁用基础 llm-retry）。
    ctx.on('agent/request-error', (async (payload, next) => {
        const sessionId = payload.agent.id;
        const routeId = service.getSelectedRoute(sessionId, payload.turn, payload.step) ?? payload.provider;
        const shouldRetry = service.excludeRouteAndCheckRetry(sessionId, payload.turn, payload.step, routeId, payload.failure);
        if (shouldRetry) {
            return { kind: 'retry' };
        }
        return next();
    }), { global: true });
    // 8.5 session/event：请求状态生命周期清理（GOV-STATE-001）。
    //     step/end 清理已完成 request state；turn/end 兜底清理该 turn；
    //     session dispose 兜底清理会话级状态。清理不删除已提交的
    //     Decision/Usage；重复/乱序通知幂等。
    ctx.on('session/event', ((session, event) => {
        if (event.type === 'step/end' &&
            event.data?.turn !== undefined &&
            event.data?.step !== undefined) {
            service.handleStepEnd(session.id, event.data.turn, event.data.step);
        }
        else if (event.type === 'turn/end' && event.data?.turn !== undefined) {
            service.handleTurnEnd(session.id, event.data.turn);
        }
    }), { global: true });
    ctx.on('session/disposed', ((session) => {
        service.handleSessionDispose(session.id);
    }), { global: true });
    // 8.6 启动对账：扫描 pending 决策并补齐/告警（GOV-TRACE-001 §3.1）。
    //     Session Event 已存在且 hash 一致 → 补 commit；不存在且可写 → 补
    //     append 后 commit；不可写或 hash 冲突 → 保留 pending（诊断告警）。
    const reconcile = await service.reconcileAudit();
    if (reconcile.pending > 0) {
        ctx.logger?.warn?.(`governor audit reconcile: ${reconcile.committed} committed, ${reconcile.pending} left pending` +
            (reconcile.conflicts.length > 0 ? `, conflicts: ${reconcile.conflicts.join(', ')}` : ''));
    }
}
export const GovernorPlugin = {
    name: 'dsh-llm-governor',
    inject: ['llm'],
    async apply(ctx, config) {
        // 0. 严格配置校验：未知字段拒绝、范围校验、条件必填。
        //    验证失败抛 ConfigError → 插件加载失败（fail closed）。
        const resolved = resolveConfig(config);
        const runtimeConfig = toRuntimeConfig(resolved);
        // 1. SQLite 仓储：storage.enabled=false 时纯内存运行；
        //    打开或迁移失败时 fail closed（不以空库继续治理与计费）。
        let repository;
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
        const serviceOptions = {};
        const identityProvider = buildIdentityProvider(resolved.identity);
        if (identityProvider !== undefined) {
            serviceOptions.identityProvider = identityProvider;
        }
        if (resolved.auto.llmClassifier.enabled &&
            resolved.auto.llmClassifier.provider.length > 0 &&
            resolved.auto.llmClassifier.model.length > 0) {
            serviceOptions.classifierBackend = createLlmClassifierBackend(ctx, resolved.auto.llmClassifier.provider, resolved.auto.llmClassifier.model, resolved.auto.llmClassifier.timeoutMs);
        }
        // 2.1 真实 DSH Session 接线：SessionStore 由 DSH host 在 Governor 之前加载，
        //      ctx.sessions 提供 get(sessionId) 与 flush(session)。
        //      注入 SessionStoreSink 以实现审计双写协议的 Session Event 侧（durable ack）；
        //      若 SessionStore 不可用（如独立测试），回退到 NullSessionEventSink（严格
        //      fail-closed：不写轨迹就不标 committed）。
        //      通过 ctx.get?.('sessions') 访问（与 webServer 同一模式），避免 Cordis
        //      inject 声明约束：未加载 SessionStore 时安全返回 undefined。
        const sessionsApi = ctx.get?.('sessions');
        if (sessionsApi !== undefined && repository !== undefined) {
            serviceOptions.sessionEventSink = new SessionStoreSink((id) => sessionsApi.get(id), (session) => sessionsApi.flush(session));
        }
        else {
            // 无 SessionStore 或无 repository：fail-closed（NullSessionEventSink 抛错）
            serviceOptions.sessionEventSink = new NullSessionEventSink();
        }
        const service = new GovernorService(ctx, runtimeConfig, repository, serviceOptions);
        // 2.2 Governor Typert Remote：严格 descriptor 由 dsh-typert-loader 从
        //     package ./typert 导出注册。Remote 方法不接收 actor/user/role，主体仅由 Host provider
        //     解析；local 模式回落为进程所有者，其他模式无 provider 时 fail closed。
        const hostServices = ctx;
        const principalProvider = hostServices.get?.('governorPrincipal');
        const localPrincipal = resolved.identity.provider === 'local'
            ? localOwnerPrincipal(resolved.identity.localUserId ?? 'local')
            : undefined;
        new GovernorRemoteService(ctx, service, async () => {
            const principal = await principalProvider?.current();
            return principal ?? localPrincipal;
        });
        // 3. 从 DSH advisory 合并模型目录（初始目录从配置构建，在构造函数中完成）
        try {
            await service.refreshModelDirectory(() => ctx.llm.listProviders(), (p) => ctx.llm.listModels(p));
        }
        catch {
            // DSH 未就绪时保留配置构建的初始目录
        }
        // 4-8.6 事件接线与启动对账（提取为可复用函数，测试可自组环境注入故障）
        await wireGovernorEvents(ctx, service);
        // 8.7 Client 侧原生注册由 package.json#dsh.client 交给 rc.8
        //     dsh-client-modules 扫描与分发；Host 进程无需也不应直接注册浏览器槽位。
        // 9. UI 与入站绑定挂载（GOV-UI-001）：
        //    - 默认只注册到 DSH webServer 的 /governor 前缀（受信 Host 通道），
        //      不新增任何监听端口。
        //    - 独立监听仅在显式 compatApi.enabled=true 时启动，且只监听
        //      IPv4/IPv6 loopback；Bearer token 未配置时自动生成 256 bit 随机值
        //      写入 $DSH_HOME/dsh-llm-governor/compat-token（owner-only，日志不打印）。
        const handle = createGovernorRequestHandler(service, {
            ...(runtimeConfig.compatApi?.token !== undefined
                ? {
                    actors: [
                        {
                            token: runtimeConfig.compatApi.token,
                            capabilities: ['governor.read', 'governor.manage', 'governor.audit'],
                        },
                    ],
                }
                : {}),
            ...(runtimeConfig.compatApi?.allowedOrigin !== undefined
                ? { allowedOrigin: runtimeConfig.compatApi.allowedOrigin }
                : {}),
        });
        if (runtimeConfig.ui?.enabled !== false) {
            const webServer = ctx.get?.('webServer');
            if (webServer !== undefined) {
                // DSH webServer 只是可达性边界，不是认证边界：兼容 HTTP API 无
                // Bearer 时 fail closed。原生页面通过上面的 Typert Remote 读取。
                const trustedHandle = createGovernorRequestHandler(service, {
                    ...(runtimeConfig.compatApi?.token !== undefined
                        ? {
                            actors: [
                                {
                                    token: runtimeConfig.compatApi.token,
                                    capabilities: ['governor.read', 'governor.manage', 'governor.audit'],
                                },
                            ],
                        }
                        : {}),
                });
                const dispose = webServer.register({
                    kind: 'prefix',
                    path: GOVERNOR_WEB_PREFIX,
                    handler: (req, res) => {
                        void handleGovernorWeb(req, res, service, identityProvider, trustedHandle).catch(() => { });
                    },
                });
                ctx.effect(() => dispose);
            }
            else if (runtimeConfig.compatApi?.enabled === true) {
                // 兼容 API：显式开启，仅 loopback（GOV-UI-001 AC 4）。
                const { createGovernorApiServer, generateCompatToken } = await import('../ui/api.js');
                const token = runtimeConfig.compatApi.token ?? generateCompatToken();
                if (runtimeConfig.compatApi.token === undefined) {
                    // 自动生成的 token 落盘（owner-only），启动日志只提示已启用、不打印 token。
                    const tokenPath = join(dirname(defaultDbPath()), 'compat-token');
                    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
                    writeFileSync(tokenPath, token, { mode: 0o600 });
                    ctx.logger?.info?.(`governor compat API enabled (loopback only); token written to ${tokenPath}`);
                }
                else {
                    ctx.logger?.info?.('governor compat API enabled (loopback only)');
                }
                const server = createGovernorApiServer(service, {
                    actors: [{ token, capabilities: ['governor.read', 'governor.manage', 'governor.audit'] }],
                    ...(runtimeConfig.compatApi.allowedOrigin !== undefined
                        ? { allowedOrigin: runtimeConfig.compatApi.allowedOrigin }
                        : {}),
                });
                // Node listen 的 host 参数不接受带方括号的 IPv6 字面量（配置沿用 [::1] 表示法）
                const listen = runtimeConfig.compatApi.listen === '[::1]' ? '::1' : '127.0.0.1';
                server.listen(runtimeConfig.compatApi.port ?? 0, listen);
                const address = server.address();
                ctx.logger?.info?.(`governor compat API listening on ${listen}:${typeof address === 'object' && address !== null ? address.port : (runtimeConfig.compatApi.port ?? 0)}`);
                ctx.effect(() => () => void server.close(() => { }));
            }
        }
        /**
         * webServer 前缀路由处理器：兼容 API 仍要求 Bearer，不把可达性当认证；
         * POST /api/bind 是 header/jwt 模式的入站身份绑定端点（仅本地回环可信）。
         */
        async function handleGovernorWeb(req, res, svc, provider, trustedHandle) {
            const request = req;
            const response = res;
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
                    response.end(JSON.stringify({
                        error: 'IDENTITY_PROVIDER_NOT_CONFIGURED',
                        code: 'IDENTITY_PROVIDER_NOT_CONFIGURED',
                    }));
                    return;
                }
                // 读取请求体 { sessionId, headers }
                const body = await new Promise((resolve, reject) => {
                    let data = '';
                    request.on?.('data', (chunk) => {
                        data += chunk.toString();
                    });
                    request.on?.('end', () => resolve(data));
                    request.on?.('error', reject);
                });
                let parsed;
                try {
                    parsed = JSON.parse(body || '{}');
                }
                catch {
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
                }
                catch (err) {
                    const code = err instanceof Error ? err.message : 'IDENTITY_INVALID';
                    response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    response.end(JSON.stringify({ error: code, code }));
                }
                return;
            }
            // 其余请求交给通用 API 处理器（剥离 /governor 前缀；无 Bearer 时 fail closed）
            const delegate = trustedHandle ?? handle;
            await delegate(request, response, GOVERNOR_WEB_PREFIX);
        }
    },
};
export default GovernorPlugin;
