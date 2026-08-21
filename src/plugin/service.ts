/**
 * GovernorService：注册为 ctx.governor 的 Cordis 服务。
 * 集成 config、model、access、credits、routing、classifier、fallback、usage 领域模块。
 */
import { Service } from '../dsh-adapter/mod.js';
import type { Context } from '../dsh-adapter/mod.js';
import type { LlmCallConfig, LlmFailure, LlmModelInfo } from '../dsh-adapter/mod.js';
import type { TaskType, RoutingMode } from '../index.js';
import type { ModelSnapshot, CanonicalRoute } from '../model/canonical.js';
import { buildModelDirectory, parseRoute } from '../model/canonical.js';
import type { UserAccessPolicy } from '../access/evaluator.js';
import { monthWindow } from '../credits/quota.js';
import type { GovernorRepository, DecisionQueryResult, AuditEntry } from '../storage/repository.js';
import { RoutingError } from '../routing/types.js';
import type { FilterInput, RoutingResult } from '../routing/types.js';
import {
  routeManual,
  routeQualityFirst,
  routeCreditFirst,
  routeAuto,
} from '../routing/strategies.js';
import type { AutoClassification } from '../routing/strategies.js';
import { sealDecision, uuidv7 } from '../routing/decision.js';
import type { DecisionCause } from '../routing/decision.js';
import { AuditPipeline, NullSessionEventSink } from './audit-pipeline.js';
import type { SessionEventSink, ReconcileResult } from './audit-pipeline.js';
import {
  restoreGovernorSelection,
  GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
} from '../dsh-adapter/session-events.js';
import { createClassifier } from '../classifier/index.js';
import type {
  Classifier,
  ClassifyInput,
  LlmClassifierBackend,
  ClassifierCache,
} from '../classifier/index.js';
import { InMemoryClassifierCache } from '../classifier/cache.js';
import { SQLiteClassifierCache } from '../classifier/sqlite-cache.js';
import type { GovernorIdentity, IdentityProvider } from '../identity/types.js';
import { FallbackState, isRetryable } from '../fallback/mod.js';
import type { FailureInfo } from '../fallback/mod.js';
import { GovernorExtensionRegistry } from '../extensions/registry.js';
import type { RoutingContext } from '../extensions/registry.js';
import type { UsageEvent } from '../usage/types.js';
import { UsageAggregator } from '../usage/aggregator.js';

/** 请求级状态：跟踪 requestId、fallbackIndex、fallback 状态。 */
interface RequestState {
  requestId: string;
  fallbackIndex: number;
  fallback: FallbackState;
  classification?: AutoClassification;
  selectedRoute?: CanonicalRoute;
  /** 本次请求实际使用的路由模式（Usage 记录使用）。 */
  mode?: RoutingMode;
  /** 本请求必须满足的能力（来自输入信号，如图片 → vision）。 */
  requiredCapabilities: string[];
  /** 本请求必须满足的输入模态（来自输入信号，如图片 → image）。 */
  requiredModalities: string[];
  partialOutputDelivered: boolean;
  /** 本逻辑请求首个 attempt 携带的 causes（initial/resume 等一次性原因）。 */
  baseCauses: DecisionCause[];
  /** 本请求上一个 attempt 决策时的配置 revision（检测 config_change）。 */
  lastDecisionConfigRevision?: number;
  /** attempt 执行状态（GOV-ATTEMPT-001 生命周期）。 */
  attemptState:
    'not_dispatched' | 'dispatch_started' | 'completed' | 'failed' | 'cancelled' | 'indeterminate';
}

/** 模型策略配置项。 */
interface ModelConfig {
  enabled?: boolean;
  multiplier?: number;
  capabilities?: string[];
  quality?: Record<string, number>;
}

/** 管理面可回读、可事务更新的路由配置快照。 */
export interface GovernorRoutingSettings {
  default: RoutingMode;
  creditFirst: {
    minimumQuality: number;
    onNoMatch: 'quality_first' | 'none';
  };
  auto: {
    confidenceThreshold: number;
    qualityThreshold: { low: number; medium: number; high: number };
  };
  fallback: {
    enabled: boolean;
    maxAttempts: number;
    afterPartialOutput: boolean;
    strategy: 'quality_first' | 'credit_first' | 'auto';
  };
  configRevision: number;
}

/** 路由配置的管理补丁；全部字段由 Host 复核范围。 */
export interface GovernorRoutingSettingsPatch {
  default?: RoutingMode;
  creditFirst?: {
    minimumQuality?: number;
    onNoMatch?: 'quality_first' | 'none';
  };
  auto?: {
    confidenceThreshold?: number;
    qualityThreshold?: { low?: number; medium?: number; high?: number };
  };
  fallback?: {
    enabled?: boolean;
    maxAttempts?: number;
    afterPartialOutput?: boolean;
    strategy?: 'quality_first' | 'credit_first' | 'auto';
  };
}

/** Usage 查询条件；时间使用可排序的 ISO 8601 字符串。 */
export interface GovernorUsageQuery {
  userId?: string;
  provider?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** 所有管理入口共用的 Usage 扫描边界。 */
export const GOVERNOR_USAGE_MAX_DAYS = 31;
export const GOVERNOR_USAGE_MAX_ROWS = 200;

/** 生成有界 Usage 查询；缺省为截至当前时刻的最近 31 天。 */
export function normalizeGovernorUsageQuery(
  query: GovernorUsageQuery,
  now = Date.now(),
): Required<Pick<GovernorUsageQuery, 'from' | 'to' | 'limit'>> & GovernorUsageQuery {
  const toMs = query.to === undefined ? now : Date.parse(query.to);
  const fromMs =
    query.from === undefined
      ? toMs - GOVERNOR_USAGE_MAX_DAYS * 24 * 60 * 60 * 1000
      : Date.parse(query.from);
  const maxWindowMs = GOVERNOR_USAGE_MAX_DAYS * 24 * 60 * 60 * 1000;
  const limit = query.limit ?? GOVERNOR_USAGE_MAX_ROWS;
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    fromMs > toMs ||
    toMs - fromMs > maxWindowMs ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > GOVERNOR_USAGE_MAX_ROWS
  ) {
    throw new Error('INVALID_REQUEST');
  }
  return {
    ...query,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    limit,
  };
}

/** 插件配置。 */
export interface GovernorPluginConfig {
  models?: Record<string, ModelConfig>;
  users?: Record<string, { allow?: string[]; monthly_credits?: number }>;
  fallback?: {
    enabled?: boolean;
    max_attempts?: number;
    after_partial_output?: boolean;
    /** Manual 模式失败后的重选策略（默认 quality_first，§10.2）。 */
    strategy?: 'quality_first' | 'credit_first' | 'auto';
  };
  routing?: {
    default?: RoutingMode;
    credit_first?: { minimum_quality?: number; on_no_match?: 'quality_first' | 'none' };
  };
  auto?: {
    confidence_threshold?: number;
    quality_threshold?: { low?: number; medium?: number; high?: number };
  };
  credits?: { tokens_per_credit?: number; timezone?: string; default_monthly_credits?: number };
  identity?: {
    provider?: 'local' | 'header' | 'jwt' | 'custom';
    local_user_id?: string;
  };
  /** SQLite 持久化：enabled=false 时纯内存运行；path 默认 $DSH_HOME 下。 */
  storage?: { enabled?: boolean; path?: string };
  /** Web UI：挂载到 DSH webServer 的 /governor 前缀（无 webServer 时可独立监听）。 */
  ui?: { enabled?: boolean; port?: number };
  /** 兼容 API：默认 enabled=false（零新增监听端口）；显式开启时仅监听 loopback。 */
  compatApi?: {
    enabled?: boolean;
    port?: number;
    listen?: '127.0.0.1' | '[::1]';
    token?: string;
    allowedOrigin?: string;
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
  /** Session Event 写入端（缺少 Session service 时默认 Null 并严格 fail closed）。 */
  sessionEventSink?: SessionEventSink;
}

/**
 * Governor 核心服务。集成全部领域模块，提供事件监听器所需的方法和 Client Remote API。
 */
export class GovernorService extends Service {
  private _models: Map<string, ModelConfig>;
  private _users: Map<string, { allow: string[]; monthlyCredits: number }>;
  private _identities = new Map<string, GovernorIdentity>();
  private _requestStates = new Map<string, RequestState>();
  private _usageAggregator = new UsageAggregator();
  private _decisions: DecisionRecordMem[] = [];
  private _modelDirectory: readonly ModelSnapshot[] = [];
  private _maxAttempts: number;
  private _afterPartialOutput: boolean;
  private _fallbackEnabled: boolean;
  private _fallbackStrategy: 'quality_first' | 'credit_first' | 'auto';
  private _defaultRouting: RoutingMode;
  private _minimumQuality: number;
  private _onNoMatch: 'quality_first' | 'none';
  private _confidenceThreshold: number;
  private _qualityThresholds: { low: number; medium: number; high: number };
  private _tokensPerCredit: number;
  private _defaultMonthlyCredits: number;
  private _usedCredits = new Map<string, bigint>();
  private _currentTurnStep = new Map<string, { turn: number; step: number }>();
  private _quotaExceededFor = new Set<string>();
  /** SQLite 仓库：提供时决策/Usage/身份/策略持久化（运行时权威）。 */
  private readonly _repository: GovernorRepository | undefined;
  /** 月度额度时区（IANA），默认 UTC。 */
  private readonly _timezone: string;
  /** local 模式的固定身份（进程所有者）。 */
  private readonly _localIdentity: GovernorIdentity | undefined;
  /** 身份提供者模式：local 自动绑定；header/jwt/custom 无绑定时 fail closed。 */
  private readonly _identityKind: 'local' | 'header' | 'jwt' | 'custom';
  /** header/jwt 模式的身份提供者实例（入站绑定用）。 */
  private readonly _identityProvider: IdentityProvider | undefined;
  /** 分类器：Hint → Rule → LLM（llmBackend 由 mod.ts 注入时启用）。 */
  private readonly _classifier: Classifier;
  /** 扩展注册表：四个领域扩展点的运行时注册 API（ctx.governor.extensions）。 */
  private readonly _extensions = new GovernorExtensionRegistry();
  /** 双写审计管线：pending → Session Event → committed（GOV-TRACE-001）。 */
  private readonly _audit: AuditPipeline;

  constructor(
    ctx: Context,
    config: GovernorPluginConfig,
    repository?: GovernorRepository,
    options?: GovernorServiceOptions,
  ) {
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
    // LLM 分类后端注入后，Auto 走完整 Hint → Rule → LLM 链；
    // GOV-CLASSIFIER-001：repository 存在时接入 SQLite 缓存
    // （HMAC 键 + TTL 7 天 + single-flight），否则用内存缓存。
    const sqliteCache =
      repository !== undefined && options?.classifierBackend !== undefined
        ? new SQLiteClassifierCache(repository)
        : undefined;
    this._classifier = createClassifier({
      confidenceThreshold: config.auto?.confidence_threshold ?? 0.7,
      ...(options?.classifierBackend !== undefined
        ? { llmBackend: options.classifierBackend }
        : {}),
      ...(sqliteCache !== undefined
        ? {
            cache: sqliteCache,
            cacheKeyBuilder: (canonicalInput: string, revision: number) =>
              sqliteCache.buildKey(canonicalInput, revision),
            configRevisionGetter: () => this.configRevision,
          }
        : options?.classifierCache !== undefined || options?.classifierBackend !== undefined
          ? { cache: options?.classifierCache ?? new InMemoryClassifierCache() }
          : {}),
    });
    this._models = new Map(Object.entries(config.models ?? {}));
    this._users = new Map(
      Object.entries(config.users ?? {}).map(([id, u]) => [
        id,
        {
          allow: u.allow ?? [],
          monthlyCredits: u.monthly_credits ?? config.credits?.default_monthly_credits ?? 100,
        },
      ]),
    );
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
      this._bootstrapConfigRevision(repository);
      this._importInitialPolicies(repository);
      this._loadPoliciesFromRepository(repository);
      this._loadRoutingSettingsFromRepository(repository);
    }
    // 双写审计管线：运行时由 mod.ts 注入 request/context carrier sink；
    // 缺少 Session service 时 Null sink 严格 fail-closed。
    this._audit = new AuditPipeline(
      repository,
      options?.sessionEventSink ?? new NullSessionEventSink(),
    );
    // 从配置构建初始模型目录（DSH advisory 在 refreshModelDirectory 时合并）
    this._modelDirectory = this._buildDirectoryFromConfig();
  }

  /** bootstrap configRevision：空库初始化为 1 并记录来源；已有库不覆盖（GOV-CONFIG-001）。 */
  private _bootstrapConfigRevision(repository: GovernorRepository): void {
    if (repository.getConfigRevision() === 0) {
      repository.setConfigRevision(1);
      repository.setBootstrapSource(`yaml-bootstrap:${new Date().toISOString()}`);
    }
  }

  /** 首次启动导入：DB 中无模型/用户策略时，把 YAML 配置写入 DB（§14 启动不覆盖 UI 修改）。 */
  private _importInitialPolicies(repository: GovernorRepository): void {
    if (repository.listModelPolicies().length === 0) {
      for (const [routeId, cfg] of this._models) {
        const idx = routeId.indexOf(':');
        if (idx <= 0) continue;
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
        repository.upsertUserPolicy(userId, BigInt(u.monthlyCredits) * 1_000_000_000n);
        for (const routeId of u.allow) {
          repository.addUserAllow(userId, routeId);
        }
      }
    }
  }

  /** 从 DB 加载模型与用户策略（DB 优先于 YAML）。 */
  private _loadPoliciesFromRepository(repository: GovernorRepository): void {
    const models = new Map<string, ModelConfig>();
    for (const row of repository.listModelPolicies()) {
      models.set(row.routeId, {
        enabled: row.enabled,
        multiplier: row.multiplierPpm / 1_000_000,
        capabilities: [...row.capabilities],
        quality: { ...row.quality },
      });
    }
    if (models.size > 0) this._models = models;
    const users = new Map<string, { allow: string[]; monthlyCredits: number }>();
    for (const userId of repository.listUserIds()) {
      const nanos = repository.getUserQuota(userId) ?? 0n;
      users.set(userId, {
        allow: repository.listUserAllow(userId),
        monthlyCredits: Number(nanos / 1_000_000_000n),
      });
    }
    if (users.size > 0) this._users = users;
  }

  /** 重启时恢复管理面写入的路由配置；损坏值 fail closed 为启动配置。 */
  private _loadRoutingSettingsFromRepository(repository: GovernorRepository): void {
    const raw = repository.getGovernorKv('routing_settings_v1');
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as GovernorRoutingSettingsPatch;
      this._applyRoutingSettingsPatch(parsed);
    } catch {
      // 不让损坏的管理 KV 产生半应用状态；启动配置仍是完整安全默认。
    }
  }

  /** 从配置构建模型目录（无 DSH advisory 时的初始视图）。 */
  private _buildDirectoryFromConfig(): readonly ModelSnapshot[] {
    const result: ModelSnapshot[] = [];
    for (const [routeId, cfg] of this._models) {
      const idx = routeId.indexOf(':');
      if (idx <= 0 || idx >= routeId.length - 1) continue;
      const provider = routeId.slice(0, idx);
      const model = routeId.slice(idx + 1);
      const snap: ModelSnapshot = {
        routeId,
        provider,
        model,
        enabled: cfg.enabled ?? true,
        multiplierPpm: Math.round((cfg.multiplier ?? 1) * 1_000_000),
        capabilities: cfg.capabilities ?? [],
        quality: (cfg.quality ?? {}) as Readonly<Partial<Record<TaskType, number>>>,
        name: model,
        inAdvisory: false,
      };
      result.push(snap);
    }
    return result;
  }

  /** 请求键。 */
  private reqKey(sessionId: string, turn: number, step: number): string {
    return `${sessionId}:${turn}:${step}`;
  }

  /** 获取或创建请求状态。 */
  private getOrCreateRequestState(sessionId: string, turn: number, step: number): RequestState {
    const key = this.reqKey(sessionId, turn, step);
    let state = this._requestStates.get(key);
    if (!state) {
      state = {
        requestId: uuidv7(),
        fallbackIndex: 0,
        fallback: new FallbackState(this._maxAttempts, this._afterPartialOutput),
        requiredCapabilities: [],
        requiredModalities: [],
        partialOutputDelivered: false,
        baseCauses: ['initial'],
        attemptState: 'not_dispatched',
      };
      this._requestStates.set(key, state);
    }
    return state;
  }

  /** 更新模型目录（从 DSH advisory 合并治理策略）。 */
  async refreshModelDirectory(
    listProviders: () => { id: string }[],
    listModels: (p: string) => Promise<readonly LlmModelInfo[]>,
  ): Promise<void> {
    const advisoryByProvider = new Map<
      string,
      {
        provider: string;
        id: string;
        name: string;
        description?: string;
        inputModalities?: readonly string[];
      }[]
    >();
    for (const p of listProviders()) {
      const models = await listModels(p.id);
      advisoryByProvider.set(
        p.id,
        models.map((m) => ({
          provider: p.id,
          id: m.id,
          name: m.name,
          ...(m.description ? { description: m.description } : {}),
          ...(m.inputModalities ? { inputModalities: m.inputModalities } : {}),
        })),
      );
    }
    // 从配置构建 ModelPolicyEntry
    const policies = new Map<
      string,
      {
        routeId: string;
        provider: string;
        model: string;
        enabled: boolean;
        multiplierPpm: number;
        capabilities: readonly string[];
        quality: Readonly<Partial<Record<TaskType, number>>>;
      }
    >();
    for (const [routeId, cfg] of this._models) {
      const idx = routeId.indexOf(':');
      if (idx <= 0) continue;
      const provider = routeId.slice(0, idx);
      const model = routeId.slice(idx + 1);
      policies.set(routeId, {
        routeId,
        provider,
        model,
        enabled: cfg.enabled ?? true,
        multiplierPpm: Math.round((cfg.multiplier ?? 1) * 1_000_000),
        capabilities: cfg.capabilities ?? [],
        quality: (cfg.quality ?? {}) as Readonly<Partial<Record<TaskType, number>>>,
      });
    }
    this._modelDirectory = buildModelDirectory(advisoryByProvider as never, policies as never);
    // 如果刷新结果为空（DSH advisory 不可用），保留配置构建的初始目录
    if (this._modelDirectory.length === 0) {
      this._modelDirectory = this._buildDirectoryFromConfig();
    }
  }

  /** 绑定身份到 session（同时持久化到 SQLite）。 */
  async bindIdentity(sessionId: string, identity: GovernorIdentity): Promise<void> {
    if (!identity.userId) throw new Error('IDENTITY_REQUIRED');
    this._identities.set(sessionId, identity);
    this._repository?.upsertSessionIdentity(
      sessionId,
      identity.userId,
      this._identityKind,
      undefined,
      identity.displayName,
      identity.email,
    );
  }

  /**
   * 获取已绑定的身份。
   *
   * 顺序：内存绑定 → local 模式固定身份 → SQLite 持久化绑定（含过期检查）。
   * header/jwt 模式下无任何绑定返回 undefined，调用方（selectModel）fail closed。
   */
  getIdentity(sessionId: string): GovernorIdentity | undefined {
    const bound = this._identities.get(sessionId);
    if (bound !== undefined) return bound;
    if (this._localIdentity !== undefined) return this._localIdentity;
    if (this._repository === undefined) return undefined;
    const row = this._repository.getSessionIdentity(sessionId);
    if (row === undefined) return undefined;
    if (row.expiresAt !== undefined && row.expiresAt < Date.now()) return undefined;
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
  async classifyStep(
    sessionId: string,
    turn: number,
    step: number,
    input: ClassifyInput,
  ): Promise<AutoClassification> {
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
  async bindIdentityFromHeaders(
    sessionId: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<GovernorIdentity> {
    const provider =
      this._identityKind === 'custom'
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
  private get globalDefault(): Set<CanonicalRoute> {
    const result = new Set<CanonicalRoute>();
    for (const snap of this._modelDirectory) {
      if (snap.enabled) result.add(snap.routeId);
    }
    return result;
  }

  /**
   * 构建 FilterInput。required capabilities/modalities 来自 pre-step 提取的输入信号。
   * 注册 ModelQualityProvider 扩展时（§6/§20），其提供的维度覆盖治理配置的 Quality。
   */
  private buildFilterInput(sessionId: string, turn: number, step: number): FilterInput {
    const state = this.getOrCreateRequestState(sessionId, turn, step);
    const identity = this.getIdentity(sessionId);
    const userPolicy = identity ? this._users.get(identity.userId) : undefined;
    const accessPolicy: UserAccessPolicy | undefined = userPolicy
      ? { userId: identity!.userId, allow: userPolicy.allow }
      : undefined;

    // ModelQualityProvider 覆盖：按维度合并到目录快照（仅路由决策视角）
    const qualityProvider = this._extensions.getModelQualityProvider();
    const snapshots =
      qualityProvider === undefined
        ? this._modelDirectory
        : this._modelDirectory.map((s) => {
            const override = qualityProvider.getQuality(s.routeId);
            const overrideKeys = Object.keys(override);
            if (overrideKeys.length === 0) return s;
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
      quotaCheck: (_routeId: CanonicalRoute) => {
        if (identity === undefined) return true; // 无身份由 selectModel 前置 fail closed
        return !this._isQuotaExceeded(identity.userId);
      },
    };
  }

  /** 计算用户本月已提交 Credits（nanos）。优先 SQLite 求和，否则内存聚合。 */
  private _usedCreditsNanos(userId: string): bigint {
    const { start, end } = monthWindow(this._timezone);
    if (this._repository !== undefined) {
      return this._repository.sumUserCredits(userId, start.toISOString(), end.toISOString());
    }
    let total = 0n;
    for (const e of this._usageAggregator.listEvents({ userId })) {
      if (!e.success) continue;
      if (e.createdAt >= start.toISOString() && e.createdAt < end.toISOString()) {
        total += e.creditNanos;
      }
    }
    return total;
  }

  /** 用户月度限额（nanos）。未配置用户使用默认额度。 */
  private _limitNanos(userId: string): bigint {
    const credits = this._users.get(userId)?.monthlyCredits ?? this._defaultMonthlyCredits;
    return BigInt(Math.max(0, Math.floor(credits))) * 1_000_000_000n;
  }

  /** 月度 Quota admission control：used >= limit 即超限（§9.2 语义）。 */
  private _isQuotaExceeded(userId: string): boolean {
    if (this._quotaExceededFor.has(userId)) return true; // 测试/审计显式开关
    return this._usedCreditsNanos(userId) >= this._limitNanos(userId);
  }

  /** 构建交给自定义 RoutingStrategy 的路由上下文。 */
  private _buildRoutingContext(
    mode: 'quality_first' | 'credit_first' | 'auto',
    classification: AutoClassification,
  ): RoutingContext {
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
  private _routeManualFallback(input: FilterInput, state: RequestState): RoutingResult {
    const classification: AutoClassification = state.classification ?? {
      taskType: 'general',
      complexity: 'medium',
      confidence: 0.5,
      source: 'rule',
    };
    const custom = this._extensions.getRoutingStrategy(this._fallbackStrategy);
    if (custom !== undefined) {
      return custom.select(
        input,
        this._buildRoutingContext(this._fallbackStrategy, classification),
      );
    }
    if (this._fallbackStrategy === 'credit_first') {
      return routeCreditFirst(
        input,
        classification.taskType,
        this._minimumQuality,
        1,
        this._onNoMatch,
      );
    }
    if (this._fallbackStrategy === 'auto') {
      return routeAuto(input, classification, this._confidenceThreshold, this._qualityThresholds);
    }
    return routeQualityFirst(input, classification.taskType);
  }

  /** 执行模型选择（被 agent/request 调用）。双写协议完成后才返回；fail closed。 */
  async selectModel(
    sessionId: string,
    turn: number,
    step: number,
    defaultConfig: LlmCallConfig,
  ): Promise<{ config: LlmCallConfig; decision: DecisionRecordMem }> {
    const state = this.getOrCreateRequestState(sessionId, turn, step);
    state.fallback.recordAttempt();
    state.attemptState = 'not_dispatched';
    this._currentTurnStep.set(sessionId, { turn, step });

    // 身份 fail closed：header/jwt/custom 模式下无绑定（含绑定过期）直接拒绝，
    // 不允许未治理的匿名请求透传到 Provider
    if (this.getIdentity(sessionId) === undefined) {
      throw new RoutingError(
        'IDENTITY_REQUIRED',
        `session ${sessionId} has no bound governor identity (provider=${this._identityKind})`,
      );
    }

    // 本 attempt 固定使用的配置 revision 快照（中途变化只影响下一个 attempt）
    const snapshotRevision = this.configRevision;
    const causes = this._computeCauses(state, snapshotRevision, sessionId);

    try {
      const filterInput = this.buildFilterInput(sessionId, turn, step);

      let result: RoutingResult;
      // 会话选择模式优先（GOV-SELECT-001）：显式 auto/manual 覆盖全局默认；
      // 无显式状态时沿用全局 routing.default。切换只影响下一个 attempt。
      const sessionMode = this.getSessionSelectionMode(sessionId);
      const mode: RoutingMode = sessionMode.isDefault ? this._defaultRouting : sessionMode.mode;
      state.mode = mode;

      if (mode === 'manual') {
        const requestedRoute = `${defaultConfig.provider}:${defaultConfig.model}` as CanonicalRoute;
        if (
          this._fallbackEnabled &&
          state.fallback.excludedRoutes.size > 0 &&
          state.fallback.excludedRoutes.has(requestedRoute)
        ) {
          // Fallback 例外：请求的模型已失败并被排除，按 fallback.strategy 重选剩余模型
          result = this._routeManualFallback(filterInput, state);
        } else {
          result = routeManual(filterInput, defaultConfig.provider, defaultConfig.model);
        }
      } else {
        // 非 Manual 模式：使用 agent/pre-step 已缓存的分类结果；未分类时回退默认 general/medium
        const classification: AutoClassification = state.classification ?? {
          taskType: 'general',
          complexity: 'medium',
          confidence: 0.5,
          source: 'rule',
        };
        const customStrategy = this._extensions.getRoutingStrategy(mode);
        if (customStrategy !== undefined) {
          // 注册的自定义 RoutingStrategy 接管该模式的路由决策（§6 扩展点）
          result = customStrategy.select(
            filterInput,
            this._buildRoutingContext(mode, classification),
          );
        } else if (mode === 'quality_first') {
          // 按当前分类的任务类型排序（pre-step 缓存；未分类回退 general）
          result = routeQualityFirst(filterInput, classification.taskType);
        } else if (mode === 'credit_first') {
          // 质量门槛同样作用于当前分类的任务类型维度
          result = routeCreditFirst(
            filterInput,
            classification.taskType,
            this._minimumQuality,
            1,
            this._onNoMatch,
          );
        } else {
          // auto：置信度低于阈值时切 Quality First，否则按复杂度映射质量门槛
          result = routeAuto(
            filterInput,
            classification,
            this._confidenceThreshold,
            this._qualityThresholds,
          );
        }
      }

      state.selectedRoute = result.selected.routeId;
      state.fallbackIndex = state.fallback.attemptCount - 1;

      // 构造不可变决策并执行双写协议（pending → Session Event → committed）
      const effectiveStrategy =
        mode === 'auto'
          ? result.decision.minimumQuality !== undefined
            ? 'credit_first'
            : 'quality_first'
          : mode;
      const sealed = sealDecision({
        requestId: state.requestId,
        turn,
        step,
        fallbackIndex: state.fallbackIndex,
        causes,
        changedFields: [],
        selectionMode: mode === 'manual' ? 'manual' : 'auto',
        effectiveStrategy,
        ...(state.classification !== undefined
          ? {
              classifier: {
                taskType: state.classification.taskType,
                complexity: state.classification.complexity,
                confidence: state.classification.confidence,
                source: state.classification.source,
              },
            }
          : {}),
        ...(result.decision.minimumQuality !== undefined
          ? { minimumQuality: result.decision.minimumQuality }
          : {}),
        candidates: result.decision.candidates,
        excluded: result.decision.excluded,
        outcome: 'selected',
        selectedRoute: result.selected.routeId,
        configRevision: snapshotRevision,
      });
      await this._audit.commitDecision(sealed, {
        sessionId,
        route: { provider: result.selected.provider, model: result.selected.model },
      });
      state.lastDecisionConfigRevision = snapshotRevision;
      // initial 只属于首个 attempt：后续 attempt 的 causes 回落到 step/fallback。
      if (state.baseCauses.length > 0) state.baseCauses = [];
      this._repository?.upsertAttemptState(state.requestId, state.fallbackIndex, 'not_dispatched');

      const decision: DecisionRecordMem = {
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

      return {
        config: {
          ...defaultConfig,
          provider: result.selected.provider,
          model: result.selected.model,
        },
        decision,
      };
    } catch (err) {
      // 审计管线自身失败（AUDIT_PERSIST_FAILED）不写 rejected 决策：
      // 此类错误发生时路由结果不可信（双写未完成），直接 fail closed。
      if (err instanceof RoutingError && err.code === 'AUDIT_PERSIST_FAILED') {
        throw err;
      }
      // 拒绝路径：无候选/准入失败也记录 rejected 决策与稳定错误码（GOV-TRACE-001 AC 5）
      if (err instanceof RoutingError) {
        state.fallbackIndex = Math.max(0, state.fallback.attemptCount - 1);
        const rejected = sealDecision({
          requestId: state.requestId,
          turn,
          step,
          fallbackIndex: state.fallbackIndex,
          causes,
          changedFields: [],
          selectionMode: this._defaultRouting === 'manual' ? 'manual' : 'auto',
          effectiveStrategy:
            this._defaultRouting === 'auto' ? 'credit_first' : this._defaultRouting,
          ...(state.classification !== undefined
            ? {
                classifier: {
                  taskType: state.classification.taskType,
                  complexity: state.classification.complexity,
                  confidence: state.classification.confidence,
                  source: state.classification.source,
                },
              }
            : {}),
          candidates: [],
          excluded: [
            {
              routeId: `${defaultConfig.provider}:${defaultConfig.model}`,
              reason: 'excluded_in_request',
            },
          ],
          outcome: 'rejected',
          errorCode: err.code,
          configRevision: snapshotRevision,
        });
        // 审计写入失败时保留原始错误（fail closed：不产生 Provider 调用）
        try {
          await this._audit.commitDecision(rejected, {
            sessionId,
            route: { provider: defaultConfig.provider, model: defaultConfig.model },
          });
        } catch {
          // 原始 RoutingError 优先抛出
        }
      }
      throw err;
    }
  }

  /** 计算本 attempt 的 causes（baseCauses + selection_mode_change + fallback + config_change + step）。 */
  private _computeCauses(
    state: RequestState,
    snapshotRevision: number,
    sessionId?: string,
  ): DecisionCause[] {
    const causes: DecisionCause[] = [...state.baseCauses];
    if (sessionId !== undefined && this._pendingModeChange.delete(sessionId)) {
      causes.push('selection_mode_change');
    }
    if (state.fallback.attemptCount > 1) causes.push('fallback');
    if (
      state.lastDecisionConfigRevision !== undefined &&
      state.lastDecisionConfigRevision !== snapshotRevision
    ) {
      causes.push('config_change');
    }
    if (causes.length === 0) causes.push('step');
    return causes;
  }

  /** 设置分类结果（被 agent/pre-step 调用）。 */
  setClassification(
    sessionId: string,
    turn: number,
    step: number,
    classification: AutoClassification,
  ): void {
    const state = this.getOrCreateRequestState(sessionId, turn, step);
    state.classification = classification;
  }

  /** 判断失败能否 Fallback（被 agent/request-error 调用）。 */
  classifyError(failure: LlmFailure): boolean {
    if (!this._fallbackEnabled) return false;
    return isRetryable(failure as FailureInfo);
  }

  /** 检查是否还能重试。 */
  canRetry(sessionId: string, turn: number, step: number): boolean {
    const state = this.getOrCreateRequestState(sessionId, turn, step);
    return state.fallback.canRetry();
  }

  /** 排除失败路由并返回是否应该重试（fallback 禁用时直接不重试）。 */
  excludeRouteAndCheckRetry(
    sessionId: string,
    turn: number,
    step: number,
    routeId: string,
    failure: LlmFailure,
  ): boolean {
    if (!this._fallbackEnabled) return false;
    const state = this.getOrCreateRequestState(sessionId, turn, step);
    if (!state.fallback.shouldRetry(failure as FailureInfo)) return false;
    state.fallback.excludeRoute(routeId);
    return true;
  }

  /** 标记部分输出已交付。 */
  markPartialOutput(sessionId: string, turn: number, step: number): void {
    const state = this._requestStates.get(this.reqKey(sessionId, turn, step));
    if (state) {
      state.fallback.markPartialOutput();
      state.partialOutputDelivered = true;
    }
  }

  /** 获取已排除的路由。 */
  getExcludedRoutes(sessionId: string, turn: number, step: number): Set<string> {
    const state = this._requestStates.get(this.reqKey(sessionId, turn, step));
    return new Set(state?.fallback.excludedRoutes ?? []);
  }

  /** 获取上次选择的 route（用于 request-error 排除）。 */
  getSelectedRoute(sessionId: string, turn: number, step: number): string | undefined {
    return this._requestStates.get(this.reqKey(sessionId, turn, step))?.selectedRoute;
  }

  /** 记录 attempt（兼容 Task 1 接口）。 */
  recordAttempt(sessionId: string, turn: number, step: number): void {
    this.getOrCreateRequestState(sessionId, turn, step).fallback.recordAttempt();
  }

  /** 记录 Usage（内存聚合 + SQLite 幂等落库）。 */
  recordUsage(record: UsageEvent): void {
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
  getRequestId(sessionId: string, turn: number, step: number): string | undefined {
    return this._requestStates.get(this.reqKey(sessionId, turn, step))?.requestId;
  }

  /** 获取 fallbackIndex（用于 stream 观察）。 */
  getFallbackIndex(sessionId: string, turn: number, step: number): number {
    const state = this._requestStates.get(this.reqKey(sessionId, turn, step));
    return state?.fallbackIndex ?? 0;
  }

  /** 获取当前 session 的 turn/step（用于 stream 观察）。 */
  getCurrentTurnStep(sessionId: string): { turn: number; step: number } | undefined {
    return this._currentTurnStep.get(sessionId);
  }

  /**
   * 获取 classifier 调用应关联的父 requestId（GOV-USAGE-001）。
   *
   * @param classifierSessionId - 形如 `governor-classifier:<uuid>` 的标记会话。
   * @returns 当前正在分类的会话的 requestId；无在途请求时 undefined。
   */
  getCurrentParentRequestId(classifierSessionId: string): string | undefined {
    void classifierSessionId;
    // 分类发生在 agent/pre-step（父请求 selectModel 之前）；父 requestId 尚未
    // 生成（requestId 在 selectModel 首次进入路由时创建）。因此 classifier
    // usage 关联当前会话最近一个 requestId（存在时），否则不关联。
    for (const state of this._requestStates.values()) {
      return state.requestId;
    }
    return undefined;
  }

  /** 计费参数：每 Credit 对应的 Token 数（来自配置，供 llm/stream 计费使用）。 */
  get tokensPerCredit(): number {
    return this._tokensPerCredit;
  }

  /** 获取请求实际使用的路由模式（Usage 记录使用，不再硬编码）。 */
  getRoutingMode(sessionId: string, turn: number, step: number): RoutingMode {
    return (
      this._requestStates.get(this.reqKey(sessionId, turn, step))?.mode ?? this._defaultRouting
    );
  }

  /** 获取模型的计费倍率（ppm）；目录中缺席时返回默认 1x。 */
  getMultiplierPpm(provider: string, model: string): number {
    const routeId = `${provider}:${model}` as CanonicalRoute;
    return this._modelDirectory.find((s) => s.routeId === routeId)?.multiplierPpm ?? 1_000_000;
  }

  /** 查询用户月度 Quota 状态（UI 与测试使用）。 */
  getQuotaStatus(userId: string): {
    usedNanos: bigint;
    limitNanos: bigint;
    remainingNanos: bigint;
    exceeded: boolean;
  } {
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

  /** 获取配置版本号（GOV-CONFIG-001：SQLite 单调递增权威；无仓库时固定 1）。 */
  get configRevision(): number {
    const revision = this._repository?.getConfigRevision() ?? 0;
    return revision > 0 ? revision : 1;
  }

  /** 设置用户额度耗尽（测试与审计用）。 */
  setQuotaExceeded(userId: string, exceeded: boolean): void {
    if (exceeded) this._quotaExceededFor.add(userId);
    else this._quotaExceededFor.delete(userId);
  }

  /**
   * 扩展注册表（§6 四个扩展点的运行时注册 API）。
   * 第三方插件加载后经 ctx.governor.extensions 注册：
   * IdentityProvider（identity.provider=custom）、TaskClassifier、
   * RoutingStrategy（按 name 接管非 Manual 模式）、ModelQualityProvider。
   */
  get extensions(): GovernorExtensionRegistry {
    return this._extensions;
  }

  // ===== Client Remote API =====

  /** 读取当前路由/Auto/Fallback 设置（管理面单一运行时权威）。 */
  async getRoutingSettings(): Promise<GovernorRoutingSettings> {
    return {
      default: this._defaultRouting,
      creditFirst: {
        minimumQuality: this._minimumQuality,
        onNoMatch: this._onNoMatch,
      },
      auto: {
        confidenceThreshold: this._confidenceThreshold,
        qualityThreshold: { ...this._qualityThresholds },
      },
      fallback: {
        enabled: this._fallbackEnabled,
        maxAttempts: this._maxAttempts,
        afterPartialOutput: this._afterPartialOutput,
        strategy: this._fallbackStrategy,
      },
      configRevision: this.configRevision,
    };
  }

  /**
   * 事务更新路由设置。数据、revision、管理审计在同一 SQLite 事务提交，
   * 持久化成功后才替换内存状态。
   */
  async updateRoutingSettings(
    patch: GovernorRoutingSettingsPatch,
    options?: { expectedRevision?: number; actor?: string },
  ): Promise<GovernorRoutingSettings> {
    const currentRevision = this.configRevision;
    if (options?.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
      throw new RoutingError(
        'REVISION_CONFLICT',
        `expected config revision ${options.expectedRevision} but current is ${currentRevision}`,
      );
    }
    const current = await this.getRoutingSettings();
    const next = this._routingSettingsWithPatch(current, patch);
    const changedFields = this._routingChangedFields(current, next);
    let newRevision = currentRevision;
    if (changedFields.length > 0 && this._repository !== undefined) {
      const repository = this._repository;
      newRevision = repository.transaction(() => {
        const revision = currentRevision + 1;
        repository.setGovernorKv(
          'routing_settings_v1',
          JSON.stringify(this._routingPersisted(next)),
        );
        repository.setConfigRevision(revision);
        repository.insertAuditEntry({
          actor: options?.actor ?? 'local',
          action: 'updateRouting',
          target: 'routing',
          changedFields,
          oldRevision: currentRevision,
          newRevision: revision,
          result: 'success',
          createdAt: new Date().toISOString(),
        });
        return revision;
      });
    }
    if (changedFields.length > 0) this._applyRoutingSettingsPatch(this._routingPersisted(next));
    return { ...(await this.getRoutingSettings()), configRevision: newRevision };
  }

  /** 合并并验证路由设置，返回完整候选快照，不修改内存。 */
  private _routingSettingsWithPatch(
    current: GovernorRoutingSettings,
    patch: GovernorRoutingSettingsPatch,
  ): GovernorRoutingSettings {
    const next: GovernorRoutingSettings = {
      default: patch.default ?? current.default,
      creditFirst: {
        minimumQuality: patch.creditFirst?.minimumQuality ?? current.creditFirst.minimumQuality,
        onNoMatch: patch.creditFirst?.onNoMatch ?? current.creditFirst.onNoMatch,
      },
      auto: {
        confidenceThreshold: patch.auto?.confidenceThreshold ?? current.auto.confidenceThreshold,
        qualityThreshold: {
          low: patch.auto?.qualityThreshold?.low ?? current.auto.qualityThreshold.low,
          medium: patch.auto?.qualityThreshold?.medium ?? current.auto.qualityThreshold.medium,
          high: patch.auto?.qualityThreshold?.high ?? current.auto.qualityThreshold.high,
        },
      },
      fallback: {
        enabled: patch.fallback?.enabled ?? current.fallback.enabled,
        maxAttempts: patch.fallback?.maxAttempts ?? current.fallback.maxAttempts,
        afterPartialOutput:
          patch.fallback?.afterPartialOutput ?? current.fallback.afterPartialOutput,
        strategy: patch.fallback?.strategy ?? current.fallback.strategy,
      },
      configRevision: current.configRevision,
    };
    const modes: readonly RoutingMode[] = ['manual', 'quality_first', 'credit_first', 'auto'];
    if (!modes.includes(next.default)) throw new Error('INVALID_ROUTING_MODE');
    if (
      !Number.isFinite(next.creditFirst.minimumQuality) ||
      next.creditFirst.minimumQuality < 0 ||
      next.creditFirst.minimumQuality > 100
    ) {
      throw new Error('INVALID_MINIMUM_QUALITY');
    }
    if (!['quality_first', 'none'].includes(next.creditFirst.onNoMatch)) {
      throw new Error('INVALID_ON_NO_MATCH');
    }
    if (
      !Number.isFinite(next.auto.confidenceThreshold) ||
      next.auto.confidenceThreshold < 0 ||
      next.auto.confidenceThreshold > 1
    ) {
      throw new Error('INVALID_CONFIDENCE_THRESHOLD');
    }
    const { low, medium, high } = next.auto.qualityThreshold;
    if (
      [low, medium, high].some((value) => !Number.isFinite(value) || value < 0 || value > 100) ||
      low > medium ||
      medium > high
    ) {
      throw new Error('INVALID_QUALITY_THRESHOLDS');
    }
    if (!Number.isInteger(next.fallback.maxAttempts) || next.fallback.maxAttempts < 1) {
      throw new Error('INVALID_MAX_ATTEMPTS');
    }
    if (!['quality_first', 'credit_first', 'auto'].includes(next.fallback.strategy)) {
      throw new Error('INVALID_FALLBACK_STRATEGY');
    }
    return next;
  }

  /** 将完整快照投影为持久补丁（排除派生的 configRevision）。 */
  private _routingPersisted(settings: GovernorRoutingSettings): GovernorRoutingSettingsPatch {
    return {
      default: settings.default,
      creditFirst: { ...settings.creditFirst },
      auto: {
        confidenceThreshold: settings.auto.confidenceThreshold,
        qualityThreshold: { ...settings.auto.qualityThreshold },
      },
      fallback: { ...settings.fallback },
    };
  }

  /** 应用已验证的路由补丁。 */
  private _applyRoutingSettingsPatch(patch: GovernorRoutingSettingsPatch): void {
    const current: GovernorRoutingSettings = {
      default: this._defaultRouting,
      creditFirst: { minimumQuality: this._minimumQuality, onNoMatch: this._onNoMatch },
      auto: {
        confidenceThreshold: this._confidenceThreshold,
        qualityThreshold: { ...this._qualityThresholds },
      },
      fallback: {
        enabled: this._fallbackEnabled,
        maxAttempts: this._maxAttempts,
        afterPartialOutput: this._afterPartialOutput,
        strategy: this._fallbackStrategy,
      },
      configRevision: this.configRevision,
    };
    const next = this._routingSettingsWithPatch(current, patch);
    this._defaultRouting = next.default;
    this._minimumQuality = next.creditFirst.minimumQuality;
    this._onNoMatch = next.creditFirst.onNoMatch;
    this._confidenceThreshold = next.auto.confidenceThreshold;
    this._qualityThresholds = { ...next.auto.qualityThreshold };
    this._fallbackEnabled = next.fallback.enabled;
    this._maxAttempts = next.fallback.maxAttempts;
    this._afterPartialOutput = next.fallback.afterPartialOutput;
    this._fallbackStrategy = next.fallback.strategy;
  }

  /** 配置审计的字段路径。 */
  private _routingChangedFields(
    current: GovernorRoutingSettings,
    next: GovernorRoutingSettings,
  ): string[] {
    const fields: string[] = [];
    if (current.default !== next.default) fields.push('default');
    if (current.creditFirst.minimumQuality !== next.creditFirst.minimumQuality)
      fields.push('creditFirst.minimumQuality');
    if (current.creditFirst.onNoMatch !== next.creditFirst.onNoMatch)
      fields.push('creditFirst.onNoMatch');
    if (current.auto.confidenceThreshold !== next.auto.confidenceThreshold)
      fields.push('auto.confidenceThreshold');
    if (current.auto.qualityThreshold.low !== next.auto.qualityThreshold.low)
      fields.push('auto.qualityThreshold.low');
    if (current.auto.qualityThreshold.medium !== next.auto.qualityThreshold.medium)
      fields.push('auto.qualityThreshold.medium');
    if (current.auto.qualityThreshold.high !== next.auto.qualityThreshold.high)
      fields.push('auto.qualityThreshold.high');
    if (current.fallback.enabled !== next.fallback.enabled) fields.push('fallback.enabled');
    if (current.fallback.maxAttempts !== next.fallback.maxAttempts)
      fields.push('fallback.maxAttempts');
    if (current.fallback.afterPartialOutput !== next.fallback.afterPartialOutput)
      fields.push('fallback.afterPartialOutput');
    if (current.fallback.strategy !== next.fallback.strategy) fields.push('fallback.strategy');
    return fields;
  }

  async listModels() {
    const configRevision = this.configRevision;
    return this._modelDirectory.map((s) => ({
      routeId: s.routeId,
      provider: s.provider,
      model: s.model,
      enabled: s.enabled,
      multiplierPpm: s.multiplierPpm,
      capabilities: [...s.capabilities],
      quality: s.quality,
      configRevision,
    }));
  }

  /**
   * 更新模型策略（管理员写入；GOV-CONFIG-001：数据与新 revision 同事务提交）。
   *
   * 接受 enabled 和 multiplier（人类可读倍率，1.5 = 1.5x）。
   * 内部将 multiplier 转换为 multiplierPpm 存储。
   * 若 routeId 在目录中但不在配置 Map，则自动创建配置项。
   * expectedRevision 提供时做 compare-and-set，不匹配抛 REVISION_CONFLICT。
   */
  async updateModel(
    routeId: string,
    patch: { enabled?: boolean; multiplier?: number },
    options?: { expectedRevision?: number; actor?: string },
  ): Promise<{
    routeId: string;
    provider: string;
    model: string;
    enabled: boolean;
    multiplierPpm: number;
    capabilities: string[];
    quality: Partial<Record<TaskType, number>>;
    configRevision: number;
  }> {
    const existingSnap = this._modelDirectory.find((s) => s.routeId === routeId);
    if (!existingSnap) {
      throw new Error('MODEL_NOT_FOUND');
    }
    // GOV-UI-002：Host 拒绝超界值（multiplier 非负；表单范围只是提示，
    // 最终准入以后端校验为准）
    if (
      patch.multiplier !== undefined &&
      (!Number.isFinite(patch.multiplier) || patch.multiplier < 0)
    ) {
      throw new Error('INVALID_MULTIPLIER');
    }

    // expected-revision 冲突保护（多标签页并发写）
    const currentRevision = this.configRevision;
    if (options?.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
      throw new RoutingError(
        'REVISION_CONFLICT',
        `expected config revision ${options.expectedRevision} but current is ${currentRevision}`,
      );
    }

    // 获取或创建配置项（只计算新值，不先改内存：持久化失败时内存与 SQLite 同为旧值）
    const cfg =
      this._models.get(routeId) ??
      ({
        enabled: existingSnap.enabled,
        multiplier: existingSnap.multiplierPpm / 1_000_000,
        capabilities: [...existingSnap.capabilities],
        quality: { ...existingSnap.quality } as Record<string, number>,
      } satisfies ModelConfig);

    // 计算补丁结果（changedFields 与旧值比较）
    const changedFields: string[] = [];
    if (patch.enabled !== undefined && patch.enabled !== cfg.enabled) changedFields.push('enabled');
    if (patch.multiplier !== undefined && patch.multiplier !== cfg.multiplier)
      changedFields.push('multiplier');
    const newEnabled = patch.enabled !== undefined ? patch.enabled : (cfg.enabled ?? true);
    const newMultiplier = patch.multiplier !== undefined ? patch.multiplier : (cfg.multiplier ?? 1);
    const newMultiplierPpm = Math.round(newMultiplier * 1_000_000);

    // 管理写入持久化：数据与新 revision、审计条目在同一 SQLite 事务提交
    // （GOV-CONFIG-001：任一写入失败整体回滚，revision 不递增，内存不提交）。
    let newRevision = currentRevision;
    const repository = this._repository;
    if (repository !== undefined) {
      newRevision = repository.transaction(() => {
        repository.upsertModelPolicy({
          routeId,
          provider: existingSnap.provider,
          model: existingSnap.model,
          enabled: newEnabled,
          multiplierPpm: newMultiplierPpm,
          capabilities: [...existingSnap.capabilities],
          quality: { ...existingSnap.quality },
        });
        if (changedFields.length > 0) {
          const next = currentRevision + 1;
          repository.setConfigRevision(next);
          repository.insertAuditEntry({
            actor: options?.actor ?? 'local',
            action: 'updateModel',
            target: routeId,
            changedFields,
            oldRevision: currentRevision,
            newRevision: next,
            result: 'success',
            createdAt: new Date().toISOString(),
          });
          return next;
        }
        return currentRevision;
      });
    }

    // 持久化成功后才提交内存状态（模型配置与目录快照）
    this._models.set(routeId, { ...cfg, enabled: newEnabled, multiplier: newMultiplier });
    this._modelDirectory = this._modelDirectory.map((s) =>
      s.routeId === routeId ? { ...s, enabled: newEnabled, multiplierPpm: newMultiplierPpm } : s,
    );

    // 返回更新后的模型视图
    const updated = this._modelDirectory.find((s) => s.routeId === routeId);
    if (!updated) throw new Error('MODEL_NOT_FOUND');
    return {
      routeId: updated.routeId,
      provider: updated.provider,
      model: updated.model,
      enabled: updated.enabled,
      multiplierPpm: updated.multiplierPpm,
      capabilities: [...updated.capabilities],
      quality: updated.quality,
      configRevision: newRevision,
    };
  }

  async listUsers() {
    const configRevision = this.configRevision;
    return [...this._users.entries()].map(([userId, u]) => {
      const usedNanos = this.getQuotaStatus(userId).usedNanos;
      return {
        userId,
        allow: [...u.allow],
        monthlyCredits: u.monthlyCredits,
        usedCredits: Number(usedNanos) / 1_000_000_000,
        usedCreditNanos: usedNanos.toString(),
        configRevision,
      };
    });
  }

  /**
   * 更新用户策略（管理员写入；GOV-CONFIG-001：数据与新 revision 同事务提交）。
   *
   * 目前支持修改 monthlyCredits。userId 不存在时抛 USER_NOT_FOUND。
   * expectedRevision 提供时做 compare-and-set，不匹配抛 REVISION_CONFLICT。
   */
  async updateUser(
    userId: string,
    patch: { monthlyCredits?: number; allow?: string[] },
    options?: { expectedRevision?: number; actor?: string },
  ) {
    const user = this._users.get(userId);
    if (!user) {
      throw new Error('USER_NOT_FOUND');
    }
    if (
      patch.monthlyCredits !== undefined &&
      (!Number.isSafeInteger(patch.monthlyCredits) || patch.monthlyCredits < 0)
    ) {
      throw new Error('INVALID_MONTHLY_CREDITS');
    }
    let nextAllow = [...user.allow].sort();
    if (patch.allow !== undefined) {
      try {
        if (patch.allow.some((routeId) => routeId.length === 0 || routeId !== routeId.trim())) {
          throw new Error('INVALID_USER_ALLOW');
        }
        for (const routeId of patch.allow) parseRoute(routeId);
      } catch {
        throw new Error('INVALID_USER_ALLOW');
      }
      nextAllow = [...new Set(patch.allow)].sort();
    }
    const currentRevision = this.configRevision;
    if (options?.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
      throw new RoutingError(
        'REVISION_CONFLICT',
        `expected config revision ${options.expectedRevision} but current is ${currentRevision}`,
      );
    }
    let newRevision = currentRevision;
    const newCredits = patch.monthlyCredits ?? user.monthlyCredits;
    const changedFields: string[] = [];
    if (newCredits !== user.monthlyCredits) changedFields.push('monthlyCredits');
    if (
      nextAllow.length !== user.allow.length ||
      nextAllow.some((routeId, index) => routeId !== [...user.allow].sort()[index])
    ) {
      changedFields.push('allow');
    }
    if (changedFields.length > 0) {
      // 管理写入持久化：数据与新 revision、审计条目在同一 SQLite 事务提交
      // （GOV-CONFIG-001：任一写入失败整体回滚，revision 不递增，内存不提交）。
      if (this._repository !== undefined) {
        const repository = this._repository;
        newRevision = repository.transaction(() => {
          repository.upsertUserPolicy(userId, BigInt(newCredits) * 1_000_000_000n);
          repository.replaceUserAllow(userId, nextAllow);
          const next = currentRevision + 1;
          repository.setConfigRevision(next);
          repository.insertAuditEntry({
            actor: options?.actor ?? 'local',
            action: 'updateUser',
            target: userId,
            changedFields,
            oldRevision: currentRevision,
            newRevision: next,
            result: 'success',
            createdAt: new Date().toISOString(),
          });
          return next;
        });
      }
      // 持久化成功后才提交内存状态（失败路径内存与 SQLite 同为旧值）。
      user.monthlyCredits = newCredits;
      user.allow = nextAllow;
    }
    const usedNanos = this.getQuotaStatus(userId).usedNanos;
    return {
      userId,
      allow: [...user.allow],
      monthlyCredits: user.monthlyCredits,
      usedCredits: Number(usedNanos) / 1_000_000_000,
      usedCreditNanos: usedNanos.toString(),
      configRevision: newRevision,
    };
  }

  async queryUsage(query: GovernorUsageQuery): Promise<UsageEvent[]> {
    // 有仓库时从 SQLite 读取（含历史进程的持久化事件），否则用内存聚合
    if (this._repository !== undefined) {
      return this._repository
        .queryUsage({ ...query, limit: query.limit ?? 1000 })
        .map((r): UsageEvent => ({
          id: `${r.requestId}:${r.fallbackIndex}`,
          requestId: r.requestId,
          sessionId: r.sessionId,
          turn: r.turn,
          step: r.step,
          userId: r.userId,
          provider: r.provider,
          model: r.model,
          routingMode: r.routingMode,
          ...(r.taskType !== undefined ? { taskType: r.taskType as TaskType } : {}),
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
    const fromMs = query.from === undefined ? undefined : Date.parse(query.from);
    const toMs = query.to === undefined ? undefined : Date.parse(query.to);
    return this._usageAggregator
      .listEvents(query)
      .filter((event) => {
        const createdAt = Date.parse(event.createdAt);
        return (
          (fromMs === undefined || createdAt >= fromMs) && (toMs === undefined || createdAt <= toMs)
        );
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, query.limit ?? Number.MAX_SAFE_INTEGER);
  }

  /**
   * 按 requestId 查询完整 attempt 集合（GOV-DECISION-001：优先读 Repository，
   * 进程重启后仍可查询；指定 fallbackIndex 时只返回一个 attempt）。
   */
  async explainDecision(requestId: string, fallbackIndex?: number): Promise<DecisionQueryResult[]> {
    if (this._repository !== undefined) {
      return this._repository.getDecisions(requestId, fallbackIndex);
    }
    return [];
  }

  /** 列表查询决策（分页：默认 50、最大 200、31 天窗口；GOV-DECISION-001 AC 3）。 */
  async listDecisions(
    opts: {
      sessionId?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: { createdAt: string; decisionId: string };
    } = {},
  ): Promise<{
    items: DecisionQueryResult[];
    nextCursor?: { createdAt: string; decisionId: string };
  }> {
    if (this._repository !== undefined) {
      return this._repository.queryDecisions(opts);
    }
    return { items: [] };
  }

  // ===== 请求状态生命周期与 attempt 状态（GOV-STATE-001 / GOV-ATTEMPT-001） =====

  /** step/end 后清理已完成 request state（幂等；重复通知安全）。 */
  handleStepEnd(sessionId: string, turn: number, step: number): void {
    this._requestStates.delete(this.reqKey(sessionId, turn, step));
  }

  /** turn/end 兜底清理该 turn 的全部 request state。 */
  handleTurnEnd(sessionId: string, turn: number): void {
    const prefix = `${sessionId}:${turn}:`;
    for (const key of this._requestStates.keys()) {
      if (key.startsWith(prefix)) this._requestStates.delete(key);
    }
  }

  /** session dispose 兜底清理（不删除已提交的 Decision/Usage）。 */
  handleSessionDispose(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this._requestStates.keys()) {
      if (key.startsWith(prefix)) this._requestStates.delete(key);
    }
    this._currentTurnStep.delete(sessionId);
    this._pendingModeChange.delete(sessionId);
    this.clearSessionSelection(sessionId);
  }

  /** 记录 dispatch_started（Provider 调用边界前；GOV-ATTEMPT-001 AC 1）。 */
  markDispatchStarted(sessionId: string, turn: number, step: number): void {
    const state = this._requestStates.get(this.reqKey(sessionId, turn, step));
    if (state === undefined) return;
    state.attemptState = 'dispatch_started';
    this._repository?.upsertAttemptState(state.requestId, state.fallbackIndex, 'dispatch_started');
  }

  /** 记录 terminal attempt 状态（completed/failed/cancelled；重复回调幂等）。 */
  markAttemptTerminal(
    sessionId: string,
    turn: number,
    step: number,
    terminal: 'completed' | 'failed' | 'cancelled',
  ): void {
    const state = this._requestStates.get(this.reqKey(sessionId, turn, step));
    if (state === undefined) return;
    state.attemptState = terminal;
    this._repository?.upsertAttemptState(state.requestId, state.fallbackIndex, terminal);
  }

  /** 读取 attempt 状态（诊断/测试）。 */
  getAttemptState(
    sessionId: string,
    turn: number,
    step: number,
  ):
    | 'not_dispatched'
    | 'dispatch_started'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'indeterminate'
    | undefined {
    return this._requestStates.get(this.reqKey(sessionId, turn, step))?.attemptState;
  }

  /** 启动对账（GOV-TRACE-001 §3.1：扫描 pending 并补齐/告警）。 */
  async reconcileAudit(): Promise<ReconcileResult> {
    return this._audit.reconcile();
  }

  /** 读取审计条目（GOV-SEC-001）。 */
  async listAuditEntries(limit = 50): Promise<AuditEntry[]> {
    return this._repository?.listAuditEntries(limit) ?? [];
  }

  /** 待对账（pending）决策数量（健康摘要）。 */
  async listPendingAuditCount(): Promise<number> {
    return this._repository?.listPendingDecisions().length ?? 0;
  }

  // ===== 会话选择模式（GOV-SELECT-001：Auto 是可持久恢复的会话控制状态） =====

  /** 会话选择状态（governor.session.v1 语义）。 */
  private _selectionStates = new Map<
    string,
    {
      mode: 'auto' | 'manual';
      lastManualRoute?: string;
      selectionRevision: number;
      lastDecisionConfigRevision?: number;
    }
  >();

  /** 已发生模式切换、待下一 attempt 消费 selection_mode_change cause 的会话。 */
  private _pendingModeChange = new Set<string>();

  /**
   * 读取会话选择模式：显式状态优先；无状态时返回全局默认（首次创建无显式
   * 选择使用全局默认，之后以会话状态为准）。
   */
  getSessionSelectionMode(sessionId: string): {
    mode: 'auto' | 'manual';
    lastManualRoute?: string;
    selectionRevision: number;
    isDefault: boolean;
  } {
    const state = this._selectionStates.get(sessionId);
    if (state !== undefined) {
      return {
        mode: state.mode,
        ...(state.lastManualRoute !== undefined ? { lastManualRoute: state.lastManualRoute } : {}),
        selectionRevision: state.selectionRevision,
        isDefault: false,
      };
    }
    return {
      mode: this._defaultRouting === 'manual' ? 'manual' : 'auto',
      selectionRevision: 0,
      isDefault: true,
    };
  }

  /**
   * 切换会话选择模式（/model 与 Composer 共用的同一 Host 方法）。
   *
   * 持久化确认（状态写入 + selection-mode 事件 durable ack）成功后才生效；
   * expectedRevision 不匹配抛 SELECTION_REVISION_CONFLICT（多标签页并发切换，
   * 只有 expected revision 匹配的一方成功）。切换只影响下一个 attempt。
   *
   * @param sessionId - 会话 ID。
   * @param mode - 目标模式。
   * @param options - expectedRevision 冲突保护与 lastManualRoute 记录。
   */
  async setSessionSelectionMode(
    sessionId: string,
    mode: 'auto' | 'manual',
    options?: {
      expectedRevision?: number;
      lastManualRoute?: string;
      /** DSH Composer/命令当前真实 route，用于全新 Session 的持久 carrier。 */
      currentRoute?: string;
    },
  ): Promise<{ mode: 'auto' | 'manual'; selectionRevision: number }> {
    const current = this.getSessionSelectionMode(sessionId);
    if (
      options?.expectedRevision !== undefined &&
      options.expectedRevision !== current.selectionRevision
    ) {
      throw new RoutingError(
        'SELECTION_REVISION_CONFLICT',
        `expected selection revision ${options.expectedRevision} but current is ${current.selectionRevision}`,
      );
    }
    const existing = this._selectionStates.get(sessionId);
    const nextRevision = current.selectionRevision + 1;
    const nextLastManualRoute =
      options?.lastManualRoute ?? options?.currentRoute ?? existing?.lastManualRoute;
    const carrierRouteId = options?.currentRoute ?? nextLastManualRoute;
    const carrierRoute = carrierRouteId !== undefined ? parseRoute(carrierRouteId) : undefined;
    // 先追加持久 selection-mode 事件（durable ack 后才更新内存状态与 UI 确认）。
    // 无 repository 时 audit 跳过（内存模式，不需要持久事件）。
    await this._audit.commitSelectionMode(
      sessionId,
      {
        schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
        selectionRevision: nextRevision,
        mode,
        ...(nextLastManualRoute !== undefined ? { lastManualRoute: nextLastManualRoute } : {}),
        ...(existing?.lastDecisionConfigRevision !== undefined
          ? { lastDecisionConfigRevision: existing.lastDecisionConfigRevision }
          : {}),
        changedAt: Date.now(),
      },
      carrierRoute,
    );
    this._selectionStates.set(sessionId, {
      mode,
      selectionRevision: nextRevision,
      ...(nextLastManualRoute !== undefined ? { lastManualRoute: nextLastManualRoute } : {}),
      ...(existing?.lastDecisionConfigRevision !== undefined
        ? { lastDecisionConfigRevision: existing.lastDecisionConfigRevision }
        : {}),
    });
    // 下一 attempt 的 causes 追加 selection_mode_change（request state 消费一次性标记）
    this._pendingModeChange.add(sessionId);
    return { mode, selectionRevision: nextRevision };
  }

  /** 从 Session 事件流恢复会话选择状态（restore/fork 路径）。 */
  restoreSessionSelection(sessionId: string, events: readonly { type: string }[]): void {
    const restored = restoreGovernorSelection(events as never);
    if (restored !== undefined) {
      this._selectionStates.set(sessionId, restored);
    }
  }

  /** 会话 dispose 时清理选择状态（与请求状态清理同生命周期）。 */
  clearSessionSelection(sessionId: string): void {
    this._selectionStates.delete(sessionId);
  }
}
