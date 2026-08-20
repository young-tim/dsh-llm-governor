/**
 * GovernorService：注册为 ctx.governor 的 Cordis 服务。
 * 集成 config、model、access、credits、routing、classifier、fallback、usage 领域模块。
 */
import { Service } from '../dsh-adapter/mod.js';
import { buildModelDirectory } from '../model/canonical.js';
import { monthWindow } from '../credits/quota.js';
import { RoutingError } from '../routing/types.js';
import { routeManual, routeQualityFirst, routeCreditFirst, routeAuto, } from '../routing/strategies.js';
import { createClassifier } from '../classifier/index.js';
import { InMemoryClassifierCache } from '../classifier/cache.js';
import { FallbackState, isRetryable } from '../fallback/mod.js';
import { GovernorExtensionRegistry } from '../extensions/registry.js';
import { UsageAggregator } from '../usage/aggregator.js';
/**
 * Governor 核心服务。集成全部领域模块，提供事件监听器所需的方法和 Client Remote API。
 */
export class GovernorService extends Service {
    _models;
    _users;
    _identities = new Map();
    _requestStates = new Map();
    _usageAggregator = new UsageAggregator();
    _decisions = [];
    _modelDirectory = [];
    _maxAttempts;
    _afterPartialOutput;
    _fallbackEnabled;
    _fallbackStrategy;
    _defaultRouting;
    _minimumQuality;
    _onNoMatch;
    _confidenceThreshold;
    _qualityThresholds;
    _tokensPerCredit;
    _defaultMonthlyCredits;
    _usedCredits = new Map();
    _currentTurnStep = new Map();
    _quotaExceededFor = new Set();
    /** SQLite 仓库：提供时决策/Usage/身份/策略持久化（运行时权威）。 */
    _repository;
    /** 月度额度时区（IANA），默认 UTC。 */
    _timezone;
    /** local 模式的固定身份（进程所有者）。 */
    _localIdentity;
    /** 身份提供者模式：local 自动绑定；header/jwt/custom 无绑定时 fail closed。 */
    _identityKind;
    /** header/jwt 模式的身份提供者实例（入站绑定用）。 */
    _identityProvider;
    /** 分类器：Hint → Rule → LLM（llmBackend 由 mod.ts 注入时启用）。 */
    _classifier;
    /** 扩展注册表：四个领域扩展点的运行时注册 API（ctx.governor.extensions）。 */
    _extensions = new GovernorExtensionRegistry();
    constructor(ctx, config, repository, options) {
        super(ctx, 'governor');
        this._repository = repository;
        this._timezone = config.credits?.timezone ?? 'UTC';
        this._identityKind = config.identity?.provider ?? 'local';
        // local 模式：DSH 进程所有者即治理用户（与 LocalIdentityProvider 同语义）
        this._localIdentity =
            this._identityKind === 'local'
                ? { userId: config.identity?.local_user_id ?? 'local' }
                : undefined;
        this._identityProvider = options?.identityProvider;
        // LLM 分类后端注入后，Auto 走完整 Hint → Rule → LLM 链
        this._classifier = createClassifier({
            confidenceThreshold: config.auto?.confidence_threshold ?? 0.7,
            ...(options?.classifierBackend !== undefined
                ? { llmBackend: options.classifierBackend }
                : {}),
            ...(options?.classifierCache !== undefined || options?.classifierBackend !== undefined
                ? { cache: options?.classifierCache ?? new InMemoryClassifierCache() }
                : {}),
        });
        this._models = new Map(Object.entries(config.models ?? {}));
        this._users = new Map(Object.entries(config.users ?? {}).map(([id, u]) => [
            id,
            {
                allow: u.allow ?? [],
                monthlyCredits: u.monthly_credits ?? config.credits?.default_monthly_credits ?? 100,
            },
        ]));
        this._maxAttempts = config.fallback?.max_attempts ?? 2;
        this._afterPartialOutput = config.fallback?.after_partial_output ?? false;
        this._fallbackEnabled = config.fallback?.enabled ?? true;
        this._fallbackStrategy = config.fallback?.strategy ?? 'quality_first';
        this._defaultRouting = config.routing?.default ?? 'manual';
        this._minimumQuality = config.routing?.credit_first?.minimum_quality ?? 85;
        this._onNoMatch = config.routing?.credit_first?.on_no_match ?? 'none';
        this._confidenceThreshold = config.auto?.confidence_threshold ?? 0.7;
        this._qualityThresholds = {
            low: config.auto?.quality_threshold?.low ?? 75,
            medium: config.auto?.quality_threshold?.medium ?? 85,
            high: config.auto?.quality_threshold?.high ?? 92,
        };
        this._tokensPerCredit = config.credits?.tokens_per_credit ?? 1_000_000;
        this._defaultMonthlyCredits = config.credits?.default_monthly_credits ?? 100;
        // DB 是运行时权威：首次启动把 YAML 中的 models/users 导入 DB，之后从 DB 加载
        if (repository !== undefined) {
            this._importInitialPolicies(repository);
            this._loadPoliciesFromRepository(repository);
        }
        // 从配置构建初始模型目录（DSH advisory 在 refreshModelDirectory 时合并）
        this._modelDirectory = this._buildDirectoryFromConfig();
    }
    /** 首次启动导入：DB 中无模型/用户策略时，把 YAML 配置写入 DB（§14 启动不覆盖 UI 修改）。 */
    _importInitialPolicies(repository) {
        if (repository.listModelPolicies().length === 0) {
            for (const [routeId, cfg] of this._models) {
                const idx = routeId.indexOf(':');
                if (idx <= 0)
                    continue;
                repository.upsertModelPolicy({
                    routeId,
                    provider: routeId.slice(0, idx),
                    model: routeId.slice(idx + 1),
                    enabled: cfg.enabled ?? true,
                    multiplierPpm: Math.round((cfg.multiplier ?? 1) * 1_000_000),
                    capabilities: cfg.capabilities ?? [],
                    quality: cfg.quality ?? {},
                });
            }
        }
        if (repository.listUserIds().length === 0) {
            for (const [userId, u] of this._users) {
                repository.upsertUserPolicy(userId, BigInt(u.monthlyCredits) * 1000000000n);
                for (const routeId of u.allow) {
                    repository.addUserAllow(userId, routeId);
                }
            }
        }
    }
    /** 从 DB 加载模型与用户策略（DB 优先于 YAML）。 */
    _loadPoliciesFromRepository(repository) {
        const models = new Map();
        for (const row of repository.listModelPolicies()) {
            models.set(row.routeId, {
                enabled: row.enabled,
                multiplier: row.multiplierPpm / 1_000_000,
                capabilities: [...row.capabilities],
                quality: { ...row.quality },
            });
        }
        if (models.size > 0)
            this._models = models;
        const users = new Map();
        for (const userId of repository.listUserIds()) {
            const nanos = repository.getUserQuota(userId) ?? 0n;
            users.set(userId, {
                allow: repository.listUserAllow(userId),
                monthlyCredits: Number(nanos / 1000000000n),
            });
        }
        if (users.size > 0)
            this._users = users;
    }
    /** 从配置构建模型目录（无 DSH advisory 时的初始视图）。 */
    _buildDirectoryFromConfig() {
        const result = [];
        for (const [routeId, cfg] of this._models) {
            const idx = routeId.indexOf(':');
            if (idx <= 0 || idx >= routeId.length - 1)
                continue;
            const provider = routeId.slice(0, idx);
            const model = routeId.slice(idx + 1);
            const snap = {
                routeId,
                provider,
                model,
                enabled: cfg.enabled ?? true,
                multiplierPpm: Math.round((cfg.multiplier ?? 1) * 1_000_000),
                capabilities: cfg.capabilities ?? [],
                quality: (cfg.quality ?? {}),
                name: model,
                inAdvisory: false,
            };
            result.push(snap);
        }
        return result;
    }
    /** 请求键。 */
    reqKey(sessionId, turn, step) {
        return `${sessionId}:${turn}:${step}`;
    }
    /** 获取或创建请求状态。 */
    getOrCreateRequestState(sessionId, turn, step) {
        const key = this.reqKey(sessionId, turn, step);
        let state = this._requestStates.get(key);
        if (!state) {
            state = {
                requestId: crypto.randomUUID(),
                fallbackIndex: 0,
                fallback: new FallbackState(this._maxAttempts, this._afterPartialOutput),
                requiredCapabilities: [],
                requiredModalities: [],
                partialOutputDelivered: false,
            };
            this._requestStates.set(key, state);
        }
        return state;
    }
    /** 更新模型目录（从 DSH advisory 合并治理策略）。 */
    async refreshModelDirectory(listProviders, listModels) {
        const advisoryByProvider = new Map();
        for (const p of listProviders()) {
            const models = await listModels(p.id);
            advisoryByProvider.set(p.id, models.map((m) => ({
                provider: p.id,
                id: m.id,
                name: m.name,
                ...(m.description ? { description: m.description } : {}),
                ...(m.inputModalities ? { inputModalities: m.inputModalities } : {}),
            })));
        }
        // 从配置构建 ModelPolicyEntry
        const policies = new Map();
        for (const [routeId, cfg] of this._models) {
            const idx = routeId.indexOf(':');
            if (idx <= 0)
                continue;
            const provider = routeId.slice(0, idx);
            const model = routeId.slice(idx + 1);
            policies.set(routeId, {
                routeId,
                provider,
                model,
                enabled: cfg.enabled ?? true,
                multiplierPpm: Math.round((cfg.multiplier ?? 1) * 1_000_000),
                capabilities: cfg.capabilities ?? [],
                quality: (cfg.quality ?? {}),
            });
        }
        this._modelDirectory = buildModelDirectory(advisoryByProvider, policies);
        // 如果刷新结果为空（DSH advisory 不可用），保留配置构建的初始目录
        if (this._modelDirectory.length === 0) {
            this._modelDirectory = this._buildDirectoryFromConfig();
        }
    }
    /** 绑定身份到 session（同时持久化到 SQLite）。 */
    async bindIdentity(sessionId, identity) {
        if (!identity.userId)
            throw new Error('IDENTITY_REQUIRED');
        this._identities.set(sessionId, identity);
        this._repository?.upsertSessionIdentity(sessionId, identity.userId, this._identityKind, undefined, identity.displayName, identity.email);
    }
    /**
     * 获取已绑定的身份。
     *
     * 顺序：内存绑定 → local 模式固定身份 → SQLite 持久化绑定（含过期检查）。
     * header/jwt 模式下无任何绑定返回 undefined，调用方（selectModel）fail closed。
     */
    getIdentity(sessionId) {
        const bound = this._identities.get(sessionId);
        if (bound !== undefined)
            return bound;
        if (this._localIdentity !== undefined)
            return this._localIdentity;
        if (this._repository === undefined)
            return undefined;
        const row = this._repository.getSessionIdentity(sessionId);
        if (row === undefined)
            return undefined;
        if (row.expiresAt !== undefined && row.expiresAt < Date.now())
            return undefined;
        return { userId: row.userId };
    }
    /**
     * 对当前步骤输入执行分类（Hint → Rule → LLM），并缓存到请求状态。
     * 注册自定义 TaskClassifier 扩展时（§6），分类完全由扩展接管。
     * 同时从输入信号提取本请求的能力/模态要求：图片输入要求 vision 能力与
     * image 模态；Tool 调用上下文要求 tool_use 能力（advisory/治理配置声明
     * 不支持时由公共过滤排除，§7.2.5）。
     * 被 agent/pre-step 调用；Auto 路由读取该分类，其他模式忽略。
     */
    async classifyStep(sessionId, turn, step, input) {
        const customClassifier = this._extensions.getTaskClassifier();
        const classification = await (customClassifier ?? this._classifier).classify(input);
        this.setClassification(sessionId, turn, step, classification);
        // 能力/模态要求：图片输入 → vision 能力 + image 模态
        const state = this.getOrCreateRequestState(sessionId, turn, step);
        if (input.hasImage === true) {
            if (!state.requiredCapabilities.includes('vision')) {
                state.requiredCapabilities = [...state.requiredCapabilities, 'vision'];
            }
            if (!state.requiredModalities.includes('image')) {
                state.requiredModalities = [...state.requiredModalities, 'image'];
            }
        }
        // 能力要求：Tool 调用上下文 → tool_use 能力（缺少该能力的模型不得入选）
        if (input.hasToolContext === true) {
            if (!state.requiredCapabilities.includes('tool_use')) {
                state.requiredCapabilities = [...state.requiredCapabilities, 'tool_use'];
            }
        }
        return classification;
    }
    /**
     * 从入站 Header 绑定身份（header/jwt/custom 模式的真实绑定路径）。
     *
     * 由部署方的可信反向代理 / companion ingress 在 session 创建或首条消息提交时，
     * 通过 /governor/api/bind 端点调用。使用配置的 IdentityProvider 验证：
     * header 模式校验可信代理标识；jwt 模式验签并校验 issuer/audience/exp/nbf；
     * custom 模式使用经 ctx.governor.extensions 注册的第三方提供者。
     * 无身份提供者（local 模式或 custom 未注册）或验证失败时抛错（fail closed）。
     *
     * @param sessionId - 要绑定的 session。
     * @param headers - 入站请求 Header（由可信代理转发）。
     * @returns 绑定后的身份。
     */
    async bindIdentityFromHeaders(sessionId, headers) {
        const provider = this._identityKind === 'custom'
            ? this._extensions.getIdentityProvider()
            : this._identityProvider;
        if (provider === undefined) {
            throw new Error('IDENTITY_PROVIDER_NOT_CONFIGURED');
        }
        const identity = await provider.resolve({ sessionId, headers });
        await this.bindIdentity(sessionId, identity);
        return identity;
    }
    /** 构建全局默认可用 route 集合。 */
    get globalDefault() {
        const result = new Set();
        for (const snap of this._modelDirectory) {
            if (snap.enabled)
                result.add(snap.routeId);
        }
        return result;
    }
    /**
     * 构建 FilterInput。required capabilities/modalities 来自 pre-step 提取的输入信号。
     * 注册 ModelQualityProvider 扩展时（§6/§20），其提供的维度覆盖治理配置的 Quality。
     */
    buildFilterInput(sessionId, turn, step) {
        const state = this.getOrCreateRequestState(sessionId, turn, step);
        const identity = this.getIdentity(sessionId);
        const userPolicy = identity ? this._users.get(identity.userId) : undefined;
        const accessPolicy = userPolicy
            ? { userId: identity.userId, allow: userPolicy.allow }
            : undefined;
        // ModelQualityProvider 覆盖：按维度合并到目录快照（仅路由决策视角）
        const qualityProvider = this._extensions.getModelQualityProvider();
        const snapshots = qualityProvider === undefined
            ? this._modelDirectory
            : this._modelDirectory.map((s) => {
                const override = qualityProvider.getQuality(s.routeId);
                const overrideKeys = Object.keys(override);
                if (overrideKeys.length === 0)
                    return s;
                return { ...s, quality: { ...s.quality, ...override } };
            });
        return {
            snapshots,
            activeProviders: new Set(snapshots.map((s) => s.provider)),
            globalDefault: this.globalDefault,
            userPolicy: accessPolicy,
            excludedRoutes: state.fallback.excludedRoutes,
            requiredCapabilities: state.requiredCapabilities,
            requiredModalities: state.requiredModalities,
            quotaCheck: (_routeId) => {
                if (identity === undefined)
                    return true; // 无身份由 selectModel 前置 fail closed
                return !this._isQuotaExceeded(identity.userId);
            },
        };
    }
    /** 计算用户本月已提交 Credits（nanos）。优先 SQLite 求和，否则内存聚合。 */
    _usedCreditsNanos(userId) {
        const { start, end } = monthWindow(this._timezone);
        if (this._repository !== undefined) {
            return this._repository.sumUserCredits(userId, start.toISOString(), end.toISOString());
        }
        let total = 0n;
        for (const e of this._usageAggregator.listEvents({ userId })) {
            if (!e.success)
                continue;
            if (e.createdAt >= start.toISOString() && e.createdAt < end.toISOString()) {
                total += e.creditNanos;
            }
        }
        return total;
    }
    /** 用户月度限额（nanos）。未配置用户使用默认额度。 */
    _limitNanos(userId) {
        const credits = this._users.get(userId)?.monthlyCredits ?? this._defaultMonthlyCredits;
        return BigInt(Math.max(0, Math.floor(credits))) * 1000000000n;
    }
    /** 月度 Quota admission control：used >= limit 即超限（§9.2 语义）。 */
    _isQuotaExceeded(userId) {
        if (this._quotaExceededFor.has(userId))
            return true; // 测试/审计显式开关
        return this._usedCreditsNanos(userId) >= this._limitNanos(userId);
    }
    /** 构建交给自定义 RoutingStrategy 的路由上下文。 */
    _buildRoutingContext(mode, classification) {
        return {
            mode,
            classification,
            minimumQuality: this._minimumQuality,
            onNoMatch: this._onNoMatch,
            confidenceThreshold: this._confidenceThreshold,
            qualityThresholds: { ...this._qualityThresholds },
        };
    }
    /**
     * Manual Fallback 重选（§10.2 唯一例外）：请求的 route 已被本请求排除
     * （失败重试 attempt）且 Fallback 显式启用时，对剩余允许模型按
     * fallback.strategy 重新选择（默认 quality_first）。
     * 注册同名自定义 RoutingStrategy 时由扩展接管。
     */
    _routeManualFallback(input, state) {
        const classification = state.classification ?? {
            taskType: 'general',
            complexity: 'medium',
            confidence: 0.5,
            source: 'rule',
        };
        const custom = this._extensions.getRoutingStrategy(this._fallbackStrategy);
        if (custom !== undefined) {
            return custom.select(input, this._buildRoutingContext(this._fallbackStrategy, classification));
        }
        if (this._fallbackStrategy === 'credit_first') {
            return routeCreditFirst(input, classification.taskType, this._minimumQuality, 1, this._onNoMatch);
        }
        if (this._fallbackStrategy === 'auto') {
            return routeAuto(input, classification, this._confidenceThreshold, this._qualityThresholds);
        }
        return routeQualityFirst(input, classification.taskType);
    }
    /** 执行模型选择（被 agent/request 调用）。 */
    selectModel(sessionId, turn, step, defaultConfig) {
        const state = this.getOrCreateRequestState(sessionId, turn, step);
        state.fallback.recordAttempt();
        this._currentTurnStep.set(sessionId, { turn, step });
        // 身份 fail closed：header/jwt/custom 模式下无绑定（含绑定过期）直接拒绝，
        // 不允许未治理的匿名请求透传到 Provider
        if (this.getIdentity(sessionId) === undefined) {
            throw new RoutingError('IDENTITY_REQUIRED', `session ${sessionId} has no bound governor identity (provider=${this._identityKind})`);
        }
        const filterInput = this.buildFilterInput(sessionId, turn, step);
        let result;
        const mode = this._defaultRouting;
        state.mode = mode;
        if (mode === 'manual') {
            const requestedRoute = `${defaultConfig.provider}:${defaultConfig.model}`;
            if (this._fallbackEnabled &&
                state.fallback.excludedRoutes.size > 0 &&
                state.fallback.excludedRoutes.has(requestedRoute)) {
                // Fallback 例外：请求的模型已失败并被排除，按 fallback.strategy 重选剩余模型
                result = this._routeManualFallback(filterInput, state);
            }
            else {
                result = routeManual(filterInput, defaultConfig.provider, defaultConfig.model);
            }
        }
        else {
            // 非 Manual 模式：使用 agent/pre-step 已缓存的分类结果；未分类时回退默认 general/medium
            const classification = state.classification ?? {
                taskType: 'general',
                complexity: 'medium',
                confidence: 0.5,
                source: 'rule',
            };
            const customStrategy = this._extensions.getRoutingStrategy(mode);
            if (customStrategy !== undefined) {
                // 注册的自定义 RoutingStrategy 接管该模式的路由决策（§6 扩展点）
                result = customStrategy.select(filterInput, this._buildRoutingContext(mode, classification));
            }
            else if (mode === 'quality_first') {
                // 按当前分类的任务类型排序（pre-step 缓存；未分类回退 general）
                result = routeQualityFirst(filterInput, classification.taskType);
            }
            else if (mode === 'credit_first') {
                // 质量门槛同样作用于当前分类的任务类型维度
                result = routeCreditFirst(filterInput, classification.taskType, this._minimumQuality, 1, this._onNoMatch);
            }
            else {
                // auto：置信度低于阈值时切 Quality First，否则按复杂度映射质量门槛
                result = routeAuto(filterInput, classification, this._confidenceThreshold, this._qualityThresholds);
            }
        }
        state.selectedRoute = result.selected.routeId;
        state.fallbackIndex = state.fallback.attemptCount - 1;
        const decision = {
            requestId: state.requestId,
            fallbackIndex: state.fallbackIndex,
            mode,
            selectedRoute: result.selected.routeId,
            selectedProvider: result.selected.provider,
            selectedModel: result.selected.model,
            excludedRoutes: [...state.fallback.excludedRoutes],
            createdAt: new Date().toISOString(),
        };
        this._decisions.push(decision);
        // 决策持久化（幂等：request_id + fallback_index）
        this._repository?.insertDecision({
            requestId: state.requestId,
            fallbackIndex: state.fallbackIndex,
            mode,
            ...(state.classification !== undefined
                ? {
                    taskType: state.classification.taskType,
                    complexity: state.classification.complexity,
                    confidence: state.classification.confidence,
                }
                : {}),
            ...(result.decision.minimumQuality !== undefined
                ? { minimumQuality: result.decision.minimumQuality }
                : {}),
            candidates: result.decision.candidates,
            excluded: result.decision.excluded,
            selected: result.selected.routeId,
            configRevision: this.configRevision,
            createdAt: decision.createdAt,
        });
        return {
            config: {
                ...defaultConfig,
                provider: result.selected.provider,
                model: result.selected.model,
            },
            decision,
        };
    }
    /** 设置分类结果（被 agent/pre-step 调用）。 */
    setClassification(sessionId, turn, step, classification) {
        const state = this.getOrCreateRequestState(sessionId, turn, step);
        state.classification = classification;
    }
    /** 判断失败能否 Fallback（被 agent/request-error 调用）。 */
    classifyError(failure) {
        if (!this._fallbackEnabled)
            return false;
        return isRetryable(failure);
    }
    /** 检查是否还能重试。 */
    canRetry(sessionId, turn, step) {
        const state = this.getOrCreateRequestState(sessionId, turn, step);
        return state.fallback.canRetry();
    }
    /** 排除失败路由并返回是否应该重试（fallback 禁用时直接不重试）。 */
    excludeRouteAndCheckRetry(sessionId, turn, step, routeId, failure) {
        if (!this._fallbackEnabled)
            return false;
        const state = this.getOrCreateRequestState(sessionId, turn, step);
        if (!state.fallback.shouldRetry(failure))
            return false;
        state.fallback.excludeRoute(routeId);
        return true;
    }
    /** 标记部分输出已交付。 */
    markPartialOutput(sessionId, turn, step) {
        const state = this._requestStates.get(this.reqKey(sessionId, turn, step));
        if (state) {
            state.fallback.markPartialOutput();
            state.partialOutputDelivered = true;
        }
    }
    /** 获取已排除的路由。 */
    getExcludedRoutes(sessionId, turn, step) {
        const state = this._requestStates.get(this.reqKey(sessionId, turn, step));
        return new Set(state?.fallback.excludedRoutes ?? []);
    }
    /** 获取上次选择的 route（用于 request-error 排除）。 */
    getSelectedRoute(sessionId, turn, step) {
        return this._requestStates.get(this.reqKey(sessionId, turn, step))?.selectedRoute;
    }
    /** 记录 attempt（兼容 Task 1 接口）。 */
    recordAttempt(sessionId, turn, step) {
        this.getOrCreateRequestState(sessionId, turn, step).fallback.recordAttempt();
    }
    /** 记录 Usage（内存聚合 + SQLite 幂等落库）。 */
    recordUsage(record) {
        this._usageAggregator.record(record);
        this._repository?.insertUsageEvent({
            requestId: record.requestId,
            fallbackIndex: record.fallbackIndex,
            sessionId: record.sessionId,
            turn: record.turn,
            step: record.step,
            userId: record.userId,
            provider: record.provider,
            model: record.model,
            routingMode: record.routingMode,
            ...(record.taskType !== undefined ? { taskType: record.taskType } : {}),
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            cacheReadTokens: record.cacheReadTokens,
            cacheWriteTokens: record.cacheWriteTokens,
            creditNanos: record.creditNanos,
            success: record.success,
            ...(record.finishKind !== undefined ? { finishKind: record.finishKind } : {}),
            ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
            ...(record.httpStatus !== undefined ? { httpStatus: record.httpStatus } : {}),
            latencyMs: record.latencyMs,
            attemptOrigin: record.attemptOrigin,
            usageMissing: record.usageMissing,
            createdAt: record.createdAt,
        });
    }
    /** 获取 requestId（用于 stream 观察）。 */
    getRequestId(sessionId, turn, step) {
        return this._requestStates.get(this.reqKey(sessionId, turn, step))?.requestId;
    }
    /** 获取 fallbackIndex（用于 stream 观察）。 */
    getFallbackIndex(sessionId, turn, step) {
        const state = this._requestStates.get(this.reqKey(sessionId, turn, step));
        return state?.fallbackIndex ?? 0;
    }
    /** 获取当前 session 的 turn/step（用于 stream 观察）。 */
    getCurrentTurnStep(sessionId) {
        return this._currentTurnStep.get(sessionId);
    }
    /** 计费参数：每 Credit 对应的 Token 数（来自配置，供 llm/stream 计费使用）。 */
    get tokensPerCredit() {
        return this._tokensPerCredit;
    }
    /** 获取请求实际使用的路由模式（Usage 记录使用，不再硬编码）。 */
    getRoutingMode(sessionId, turn, step) {
        return (this._requestStates.get(this.reqKey(sessionId, turn, step))?.mode ?? this._defaultRouting);
    }
    /** 获取模型的计费倍率（ppm）；目录中缺席时返回默认 1x。 */
    getMultiplierPpm(provider, model) {
        const routeId = `${provider}:${model}`;
        return this._modelDirectory.find((s) => s.routeId === routeId)?.multiplierPpm ?? 1_000_000;
    }
    /** 查询用户月度 Quota 状态（UI 与测试使用）。 */
    getQuotaStatus(userId) {
        const usedNanos = this._usedCreditsNanos(userId);
        const limitNanos = this._limitNanos(userId);
        const exceeded = usedNanos >= limitNanos;
        return {
            usedNanos,
            limitNanos,
            remainingNanos: exceeded ? 0n : limitNanos - usedNanos,
            exceeded,
        };
    }
    /** 获取配置版本号。 */
    get configRevision() {
        return 1;
    }
    /** 设置用户额度耗尽（测试与审计用）。 */
    setQuotaExceeded(userId, exceeded) {
        if (exceeded)
            this._quotaExceededFor.add(userId);
        else
            this._quotaExceededFor.delete(userId);
    }
    /**
     * 扩展注册表（§6 四个扩展点的运行时注册 API）。
     * 第三方插件加载后经 ctx.governor.extensions 注册：
     * IdentityProvider（identity.provider=custom）、TaskClassifier、
     * RoutingStrategy（按 name 接管非 Manual 模式）、ModelQualityProvider。
     */
    get extensions() {
        return this._extensions;
    }
    // ===== Client Remote API =====
    async listModels() {
        return this._modelDirectory.map((s) => ({
            routeId: s.routeId,
            provider: s.provider,
            model: s.model,
            enabled: s.enabled,
            multiplierPpm: s.multiplierPpm,
            capabilities: [...s.capabilities],
            quality: s.quality,
        }));
    }
    /**
     * 更新模型策略（管理员写入）。
     *
     * 接受 enabled 和 multiplier（人类可读倍率，1.5 = 1.5x）。
     * 内部将 multiplier 转换为 multiplierPpm 存储。
     * 若 routeId 在目录中但不在配置 Map，则自动创建配置项。
     */
    async updateModel(routeId, patch) {
        const existingSnap = this._modelDirectory.find((s) => s.routeId === routeId);
        if (!existingSnap) {
            throw new Error('MODEL_NOT_FOUND');
        }
        // 获取或创建配置项
        const cfg = this._models.get(routeId) ??
            {
                enabled: existingSnap.enabled,
                multiplier: existingSnap.multiplierPpm / 1_000_000,
                capabilities: [...existingSnap.capabilities],
                quality: { ...existingSnap.quality },
            };
        this._models.set(routeId, cfg);
        // 应用补丁
        if (patch.enabled !== undefined)
            cfg.enabled = patch.enabled;
        if (patch.multiplier !== undefined)
            cfg.multiplier = patch.multiplier;
        // 更新模型目录中对应快照
        const newEnabled = cfg.enabled ?? true;
        const newMultiplierPpm = Math.round((cfg.multiplier ?? 1) * 1_000_000);
        this._modelDirectory = this._modelDirectory.map((s) => s.routeId === routeId ? { ...s, enabled: newEnabled, multiplierPpm: newMultiplierPpm } : s);
        // 管理写入持久化（DB 是运行时权威，重启后不回退到 YAML）
        this._repository?.upsertModelPolicy({
            routeId,
            provider: existingSnap.provider,
            model: existingSnap.model,
            enabled: newEnabled,
            multiplierPpm: newMultiplierPpm,
            capabilities: [...existingSnap.capabilities],
            quality: { ...existingSnap.quality },
        });
        // 返回更新后的模型视图
        const updated = this._modelDirectory.find((s) => s.routeId === routeId);
        if (!updated)
            throw new Error('MODEL_NOT_FOUND');
        return {
            routeId: updated.routeId,
            provider: updated.provider,
            model: updated.model,
            enabled: updated.enabled,
            multiplierPpm: updated.multiplierPpm,
            capabilities: [...updated.capabilities],
            quality: updated.quality,
        };
    }
    async listUsers() {
        return [...this._users.entries()].map(([userId, u]) => ({
            userId,
            allow: u.allow,
            monthlyCredits: u.monthlyCredits,
        }));
    }
    /**
     * 更新用户策略（管理员写入）。
     *
     * 目前支持修改 monthlyCredits。userId 不存在时抛 USER_NOT_FOUND。
     */
    async updateUser(userId, patch) {
        const user = this._users.get(userId);
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }
        if (patch.monthlyCredits !== undefined) {
            user.monthlyCredits = patch.monthlyCredits;
            // 管理写入持久化（DB 是运行时权威）
            this._repository?.upsertUserPolicy(userId, BigInt(Math.max(0, Math.floor(user.monthlyCredits))) * 1000000000n);
        }
        return {
            userId,
            allow: user.allow,
            monthlyCredits: user.monthlyCredits,
        };
    }
    async queryUsage(query) {
        // 有仓库时从 SQLite 读取（含历史进程的持久化事件），否则用内存聚合
        if (this._repository !== undefined) {
            return this._repository.queryUsage({ ...query, limit: 1000 }).map((r) => ({
                id: `${r.requestId}:${r.fallbackIndex}`,
                requestId: r.requestId,
                sessionId: r.sessionId,
                turn: r.turn,
                step: r.step,
                userId: r.userId,
                provider: r.provider,
                model: r.model,
                routingMode: r.routingMode,
                ...(r.taskType !== undefined ? { taskType: r.taskType } : {}),
                inputTokens: r.inputTokens,
                outputTokens: r.outputTokens,
                cacheReadTokens: r.cacheReadTokens,
                cacheWriteTokens: r.cacheWriteTokens,
                creditNanos: r.creditNanos,
                success: r.success,
                ...(r.finishKind !== undefined ? { finishKind: r.finishKind } : {}),
                ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
                ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
                latencyMs: r.latencyMs,
                fallbackIndex: r.fallbackIndex,
                attemptOrigin: r.attemptOrigin,
                usageMissing: r.usageMissing,
                createdAt: r.createdAt,
            }));
        }
        return this._usageAggregator.listEvents(query);
    }
    async explainDecision(requestId) {
        return this._decisions.filter((d) => d.requestId === requestId);
    }
    async listDecisions() {
        return [...this._decisions];
    }
}
