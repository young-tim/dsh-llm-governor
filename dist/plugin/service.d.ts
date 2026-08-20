/**
 * GovernorService：注册为 ctx.governor 的 Cordis 服务。
 * 集成 config、model、access、credits、routing、classifier、fallback、usage 领域模块。
 */
import { Service } from '../dsh-adapter/mod.js';
import type { Context } from '../dsh-adapter/mod.js';
import type { LlmCallConfig, LlmFailure, LlmModelInfo } from '../dsh-adapter/mod.js';
import type { RoutingMode } from '../index.js';
import type { GovernorRepository } from '../storage/repository.js';
import type { AutoClassification } from '../routing/strategies.js';
import type { ClassifyInput, LlmClassifierBackend, ClassifierCache } from '../classifier/index.js';
import type { GovernorIdentity, IdentityProvider } from '../identity/types.js';
import { GovernorExtensionRegistry } from '../extensions/registry.js';
import type { UsageEvent } from '../usage/types.js';
/** 模型策略配置项。 */
interface ModelConfig {
    enabled?: boolean;
    multiplier?: number;
    capabilities?: string[];
    quality?: Record<string, number>;
}
/** 插件配置。 */
export interface GovernorPluginConfig {
    models?: Record<string, ModelConfig>;
    users?: Record<string, {
        allow?: string[];
        monthly_credits?: number;
    }>;
    fallback?: {
        enabled?: boolean;
        max_attempts?: number;
        after_partial_output?: boolean;
        /** Manual 模式失败后的重选策略（默认 quality_first，§10.2）。 */
        strategy?: 'quality_first' | 'credit_first' | 'auto';
    };
    routing?: {
        default?: RoutingMode;
        credit_first?: {
            minimum_quality?: number;
            on_no_match?: 'quality_first' | 'none';
        };
    };
    auto?: {
        confidence_threshold?: number;
        quality_threshold?: {
            low?: number;
            medium?: number;
            high?: number;
        };
    };
    credits?: {
        tokens_per_credit?: number;
        timezone?: string;
        default_monthly_credits?: number;
    };
    identity?: {
        provider?: 'local' | 'header' | 'jwt' | 'custom';
        local_user_id?: string;
    };
    /** SQLite 持久化：enabled=false 时纯内存运行；path 默认 $DSH_HOME 下。 */
    storage?: {
        enabled?: boolean;
        path?: string;
    };
    /** Web UI：挂载到 DSH webServer 的 /governor 前缀（无 webServer 时可独立监听）。 */
    ui?: {
        enabled?: boolean;
        port?: number;
    };
}
/** 决策记录（简化版，用于内存存储）。 */
interface DecisionRecordMem {
    requestId: string;
    fallbackIndex: number;
    mode: string;
    selectedRoute: string;
    selectedProvider: string;
    selectedModel: string;
    excludedRoutes: string[];
    createdAt: string;
}
/** 服务构造选项：注入身份提供者实例与分类器后端/缓存。 */
export interface GovernorServiceOptions {
    /** header/jwt 模式的身份提供者实例（由 mod.ts 从已验证配置构建）。 */
    identityProvider?: IdentityProvider;
    /** LLM 分类后端（由 mod.ts 基于 ctx.llm 构建）。 */
    classifierBackend?: LlmClassifierBackend;
    /** 分类结果缓存（默认 InMemoryClassifierCache）。 */
    classifierCache?: ClassifierCache;
}
/**
 * Governor 核心服务。集成全部领域模块，提供事件监听器所需的方法和 Client Remote API。
 */
export declare class GovernorService extends Service {
    private _models;
    private _users;
    private _identities;
    private _requestStates;
    private _usageAggregator;
    private _decisions;
    private _modelDirectory;
    private _maxAttempts;
    private _afterPartialOutput;
    private _fallbackEnabled;
    private _fallbackStrategy;
    private _defaultRouting;
    private _minimumQuality;
    private _onNoMatch;
    private _confidenceThreshold;
    private _qualityThresholds;
    private _tokensPerCredit;
    private _defaultMonthlyCredits;
    private _usedCredits;
    private _currentTurnStep;
    private _quotaExceededFor;
    /** SQLite 仓库：提供时决策/Usage/身份/策略持久化（运行时权威）。 */
    private readonly _repository;
    /** 月度额度时区（IANA），默认 UTC。 */
    private readonly _timezone;
    /** local 模式的固定身份（进程所有者）。 */
    private readonly _localIdentity;
    /** 身份提供者模式：local 自动绑定；header/jwt/custom 无绑定时 fail closed。 */
    private readonly _identityKind;
    /** header/jwt 模式的身份提供者实例（入站绑定用）。 */
    private readonly _identityProvider;
    /** 分类器：Hint → Rule → LLM（llmBackend 由 mod.ts 注入时启用）。 */
    private readonly _classifier;
    /** 扩展注册表：四个领域扩展点的运行时注册 API（ctx.governor.extensions）。 */
    private readonly _extensions;
    constructor(ctx: Context, config: GovernorPluginConfig, repository?: GovernorRepository, options?: GovernorServiceOptions);
    /** 首次启动导入：DB 中无模型/用户策略时，把 YAML 配置写入 DB（§14 启动不覆盖 UI 修改）。 */
    private _importInitialPolicies;
    /** 从 DB 加载模型与用户策略（DB 优先于 YAML）。 */
    private _loadPoliciesFromRepository;
    /** 从配置构建模型目录（无 DSH advisory 时的初始视图）。 */
    private _buildDirectoryFromConfig;
    /** 请求键。 */
    private reqKey;
    /** 获取或创建请求状态。 */
    private getOrCreateRequestState;
    /** 更新模型目录（从 DSH advisory 合并治理策略）。 */
    refreshModelDirectory(listProviders: () => {
        id: string;
    }[], listModels: (p: string) => Promise<readonly LlmModelInfo[]>): Promise<void>;
    /** 绑定身份到 session（同时持久化到 SQLite）。 */
    bindIdentity(sessionId: string, identity: GovernorIdentity): Promise<void>;
    /**
     * 获取已绑定的身份。
     *
     * 顺序：内存绑定 → local 模式固定身份 → SQLite 持久化绑定（含过期检查）。
     * header/jwt 模式下无任何绑定返回 undefined，调用方（selectModel）fail closed。
     */
    getIdentity(sessionId: string): GovernorIdentity | undefined;
    /**
     * 对当前步骤输入执行分类（Hint → Rule → LLM），并缓存到请求状态。
     * 注册自定义 TaskClassifier 扩展时（§6），分类完全由扩展接管。
     * 同时从输入信号提取本请求的能力/模态要求：图片输入要求 vision 能力与
     * image 模态；Tool 调用上下文要求 tool_use 能力（advisory/治理配置声明
     * 不支持时由公共过滤排除，§7.2.5）。
     * 被 agent/pre-step 调用；Auto 路由读取该分类，其他模式忽略。
     */
    classifyStep(sessionId: string, turn: number, step: number, input: ClassifyInput): Promise<AutoClassification>;
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
    bindIdentityFromHeaders(sessionId: string, headers: Readonly<Record<string, string>>): Promise<GovernorIdentity>;
    /** 构建全局默认可用 route 集合。 */
    private get globalDefault();
    /**
     * 构建 FilterInput。required capabilities/modalities 来自 pre-step 提取的输入信号。
     * 注册 ModelQualityProvider 扩展时（§6/§20），其提供的维度覆盖治理配置的 Quality。
     */
    private buildFilterInput;
    /** 计算用户本月已提交 Credits（nanos）。优先 SQLite 求和，否则内存聚合。 */
    private _usedCreditsNanos;
    /** 用户月度限额（nanos）。未配置用户使用默认额度。 */
    private _limitNanos;
    /** 月度 Quota admission control：used >= limit 即超限（§9.2 语义）。 */
    private _isQuotaExceeded;
    /** 构建交给自定义 RoutingStrategy 的路由上下文。 */
    private _buildRoutingContext;
    /**
     * Manual Fallback 重选（§10.2 唯一例外）：请求的 route 已被本请求排除
     * （失败重试 attempt）且 Fallback 显式启用时，对剩余允许模型按
     * fallback.strategy 重新选择（默认 quality_first）。
     * 注册同名自定义 RoutingStrategy 时由扩展接管。
     */
    private _routeManualFallback;
    /** 执行模型选择（被 agent/request 调用）。 */
    selectModel(sessionId: string, turn: number, step: number, defaultConfig: LlmCallConfig): {
        config: LlmCallConfig;
        decision: DecisionRecordMem;
    };
    /** 设置分类结果（被 agent/pre-step 调用）。 */
    setClassification(sessionId: string, turn: number, step: number, classification: AutoClassification): void;
    /** 判断失败能否 Fallback（被 agent/request-error 调用）。 */
    classifyError(failure: LlmFailure): boolean;
    /** 检查是否还能重试。 */
    canRetry(sessionId: string, turn: number, step: number): boolean;
    /** 排除失败路由并返回是否应该重试（fallback 禁用时直接不重试）。 */
    excludeRouteAndCheckRetry(sessionId: string, turn: number, step: number, routeId: string, failure: LlmFailure): boolean;
    /** 标记部分输出已交付。 */
    markPartialOutput(sessionId: string, turn: number, step: number): void;
    /** 获取已排除的路由。 */
    getExcludedRoutes(sessionId: string, turn: number, step: number): Set<string>;
    /** 获取上次选择的 route（用于 request-error 排除）。 */
    getSelectedRoute(sessionId: string, turn: number, step: number): string | undefined;
    /** 记录 attempt（兼容 Task 1 接口）。 */
    recordAttempt(sessionId: string, turn: number, step: number): void;
    /** 记录 Usage（内存聚合 + SQLite 幂等落库）。 */
    recordUsage(record: UsageEvent): void;
    /** 获取 requestId（用于 stream 观察）。 */
    getRequestId(sessionId: string, turn: number, step: number): string | undefined;
    /** 获取 fallbackIndex（用于 stream 观察）。 */
    getFallbackIndex(sessionId: string, turn: number, step: number): number;
    /** 获取当前 session 的 turn/step（用于 stream 观察）。 */
    getCurrentTurnStep(sessionId: string): {
        turn: number;
        step: number;
    } | undefined;
    /** 计费参数：每 Credit 对应的 Token 数（来自配置，供 llm/stream 计费使用）。 */
    get tokensPerCredit(): number;
    /** 获取请求实际使用的路由模式（Usage 记录使用，不再硬编码）。 */
    getRoutingMode(sessionId: string, turn: number, step: number): RoutingMode;
    /** 获取模型的计费倍率（ppm）；目录中缺席时返回默认 1x。 */
    getMultiplierPpm(provider: string, model: string): number;
    /** 查询用户月度 Quota 状态（UI 与测试使用）。 */
    getQuotaStatus(userId: string): {
        usedNanos: bigint;
        limitNanos: bigint;
        remainingNanos: bigint;
        exceeded: boolean;
    };
    /** 获取配置版本号。 */
    get configRevision(): number;
    /** 设置用户额度耗尽（测试与审计用）。 */
    setQuotaExceeded(userId: string, exceeded: boolean): void;
    /**
     * 扩展注册表（§6 四个扩展点的运行时注册 API）。
     * 第三方插件加载后经 ctx.governor.extensions 注册：
     * IdentityProvider（identity.provider=custom）、TaskClassifier、
     * RoutingStrategy（按 name 接管非 Manual 模式）、ModelQualityProvider。
     */
    get extensions(): GovernorExtensionRegistry;
    listModels(): Promise<{
        routeId: string;
        provider: string;
        model: string;
        enabled: boolean;
        multiplierPpm: number;
        capabilities: string[];
        quality: Readonly<Partial<Record<"general" | "coding" | "reasoning" | "writing" | "data_analysis" | "vision" | "tool_use", number>>>;
    }[]>;
    /**
     * 更新模型策略（管理员写入）。
     *
     * 接受 enabled 和 multiplier（人类可读倍率，1.5 = 1.5x）。
     * 内部将 multiplier 转换为 multiplierPpm 存储。
     * 若 routeId 在目录中但不在配置 Map，则自动创建配置项。
     */
    updateModel(routeId: string, patch: {
        enabled?: boolean;
        multiplier?: number;
    }): Promise<{
        routeId: string;
        provider: string;
        model: string;
        enabled: boolean;
        multiplierPpm: number;
        capabilities: string[];
        quality: Readonly<Partial<Record<"general" | "coding" | "reasoning" | "writing" | "data_analysis" | "vision" | "tool_use", number>>>;
    }>;
    listUsers(): Promise<{
        userId: string;
        allow: string[];
        monthlyCredits: number;
    }[]>;
    /**
     * 更新用户策略（管理员写入）。
     *
     * 目前支持修改 monthlyCredits。userId 不存在时抛 USER_NOT_FOUND。
     */
    updateUser(userId: string, patch: {
        monthlyCredits?: number;
    }): Promise<{
        userId: string;
        allow: string[];
        monthlyCredits: number;
    }>;
    queryUsage(query: {
        userId?: string;
        provider?: string;
    }): Promise<UsageEvent[]>;
    explainDecision(requestId: string): Promise<DecisionRecordMem[]>;
    listDecisions(): Promise<DecisionRecordMem[]>;
}
export {};
