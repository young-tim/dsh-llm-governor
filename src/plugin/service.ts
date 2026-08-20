/**
 * GovernorService：注册为 ctx.governor 的 Cordis 服务。
 * 集成 config、model、access、credits、routing、classifier、fallback、usage 领域模块。
 */
import { Service } from '../dsh-adapter/mod.js';
import type { Context } from '../dsh-adapter/mod.js';
import type {
  LlmCallConfig,
  LlmFailure,
  GenerateOptions,
  StreamChunk,
  TokenUsage,
  LlmModelInfo,
} from '../dsh-adapter/mod.js';
import type { GovernorIdentity } from '../index.js';
import type { TaskType, RoutingMode } from '../index.js';
import type { ModelSnapshot, CanonicalRoute } from '../model/canonical.js';
import { buildModelDirectory, canonicalRoute } from '../model/canonical.js';
import type { UserAccessPolicy } from '../access/evaluator.js';
import { filterByAccess } from '../access/evaluator.js';
import { computeCreditNanos } from '../credits/calc.js';
import type { FilterInput, RoutingResult, DecisionRecord } from '../routing/types.js';
import {
  routeManual,
  routeQualityFirst,
  routeCreditFirst,
  routeAuto,
} from '../routing/strategies.js';
import type { AutoClassification } from '../routing/strategies.js';
import { FallbackState, isRetryable } from '../fallback/mod.js';
import type { FailureInfo } from '../fallback/mod.js';
import { observeStream } from '../usage/observer.js';
import type { UsageEvent } from '../usage/types.js';
import { UsageAggregator } from '../usage/aggregator.js';

/** 请求级状态：跟踪 requestId、fallbackIndex、fallback 状态。 */
interface RequestState {
  requestId: string;
  fallbackIndex: number;
  fallback: FallbackState;
  classification?: AutoClassification;
  selectedRoute?: CanonicalRoute;
  partialOutputDelivered: boolean;
}

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
  users?: Record<string, { allow?: string[]; monthly_credits?: number }>;
  fallback?: { enabled?: boolean; max_attempts?: number; after_partial_output?: boolean };
  routing?: {
    default?: RoutingMode;
    credit_first?: { minimum_quality?: number; on_no_match?: 'quality_first' | 'none' };
  };
  auto?: {
    confidence_threshold?: number;
    quality_threshold?: { low?: number; medium?: number; high?: number };
  };
  credits?: { tokens_per_credit?: number; timezone?: string; default_monthly_credits?: number };
  identity?: { provider?: 'local' | 'header' | 'jwt'; local_user_id?: string };
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

  constructor(ctx: Context, config: GovernorPluginConfig) {
    super(ctx, 'governor');
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
    // 从配置构建初始模型目录（DSH advisory 在 refreshModelDirectory 时合并）
    this._modelDirectory = this._buildDirectoryFromConfig();
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
        requestId: crypto.randomUUID(),
        fallbackIndex: 0,
        fallback: new FallbackState(this._maxAttempts, this._afterPartialOutput),
        partialOutputDelivered: false,
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

  /** 绑定身份到 session。 */
  async bindIdentity(sessionId: string, identity: GovernorIdentity): Promise<void> {
    if (!identity.userId) throw new Error('IDENTITY_REQUIRED');
    this._identities.set(sessionId, identity);
  }

  /** 获取已绑定的身份。 */
  getIdentity(sessionId: string): GovernorIdentity | undefined {
    return this._identities.get(sessionId);
  }

  /** 构建全局默认可用 route 集合。 */
  private get globalDefault(): Set<CanonicalRoute> {
    const result = new Set<CanonicalRoute>();
    for (const snap of this._modelDirectory) {
      if (snap.enabled) result.add(snap.routeId);
    }
    return result;
  }

  /** 构建 FilterInput。 */
  private buildFilterInput(
    sessionId: string,
    turn: number,
    step: number,
    requiredCapabilities: string[],
    requiredModalities: string[],
  ): FilterInput {
    const state = this.getOrCreateRequestState(sessionId, turn, step);
    const identity = this._identities.get(sessionId);
    const userPolicy = identity ? this._users.get(identity.userId) : undefined;
    const accessPolicy: UserAccessPolicy | undefined = userPolicy
      ? { userId: identity!.userId, allow: userPolicy.allow }
      : undefined;

    return {
      snapshots: this._modelDirectory,
      activeProviders: new Set(this._modelDirectory.map((s) => s.provider)),
      globalDefault: this.globalDefault,
      userPolicy: accessPolicy,
      excludedRoutes: state.fallback.excludedRoutes,
      requiredCapabilities,
      requiredModalities,
      quotaCheck: (routeId: CanonicalRoute) => {
        const identity = this._identities.get(sessionId);
        if (identity && this._quotaExceededFor.has(identity.userId)) return false;
        return true;
      },
    };
  }

  /** 执行模型选择（被 agent/request 调用）。 */
  selectModel(
    sessionId: string,
    turn: number,
    step: number,
    defaultConfig: LlmCallConfig,
  ): { config: LlmCallConfig; decision: DecisionRecordMem } {
    const state = this.getOrCreateRequestState(sessionId, turn, step);
    state.fallback.recordAttempt();
    this._currentTurnStep.set(sessionId, { turn, step });

    const filterInput = this.buildFilterInput(sessionId, turn, step, [], []);

    let result: RoutingResult;
    const mode = this._defaultRouting;

    if (mode === 'manual') {
      result = routeManual(filterInput, defaultConfig.provider, defaultConfig.model);
    } else if (mode === 'quality_first') {
      result = routeQualityFirst(filterInput, 'general');
    } else if (mode === 'credit_first') {
      result = routeCreditFirst(filterInput, 'general', this._minimumQuality, 1, this._onNoMatch);
    } else {
      // auto — Task 3: 使用分类器（简化版：默认 general/medium/0.5）
      const classification: AutoClassification = state.classification ?? {
        taskType: 'general',
        complexity: 'medium',
        confidence: 0.5,
        source: 'rule',
      };
      result = routeAuto(
        filterInput,
        classification,
        this._confidenceThreshold,
        this._qualityThresholds,
      );
    }

    state.selectedRoute = result.selected.routeId;
    state.fallbackIndex = state.fallback.attemptCount - 1;

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

  /** 排除失败路由并返回是否应该重试。 */
  excludeRouteAndCheckRetry(
    sessionId: string,
    turn: number,
    step: number,
    routeId: string,
    failure: LlmFailure,
  ): boolean {
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

  /** 记录 Usage。 */
  recordUsage(record: UsageEvent): void {
    this._usageAggregator.record(record);
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

  /** 获取配置版本号。 */
  get configRevision(): number {
    return 1;
  }

  /** 设置用户额度耗尽（测试与审计用）。 */
  setQuotaExceeded(userId: string, exceeded: boolean): void {
    if (exceeded) this._quotaExceededFor.add(userId);
    else this._quotaExceededFor.delete(userId);
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
  async updateModel(routeId: string, patch: { enabled?: boolean; multiplier?: number }) {
    const existingSnap = this._modelDirectory.find((s) => s.routeId === routeId);
    if (!existingSnap) {
      throw new Error('MODEL_NOT_FOUND');
    }

    // 获取或创建配置项
    const cfg =
      this._models.get(routeId) ??
      ({
        enabled: existingSnap.enabled,
        multiplier: existingSnap.multiplierPpm / 1_000_000,
        capabilities: [...existingSnap.capabilities],
        quality: { ...existingSnap.quality } as Record<string, number>,
      } satisfies ModelConfig);
    this._models.set(routeId, cfg);

    // 应用补丁
    if (patch.enabled !== undefined) cfg.enabled = patch.enabled;
    if (patch.multiplier !== undefined) cfg.multiplier = patch.multiplier;

    // 更新模型目录中对应快照
    const newEnabled = cfg.enabled ?? true;
    const newMultiplierPpm = Math.round((cfg.multiplier ?? 1) * 1_000_000);
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
  async updateUser(userId: string, patch: { monthlyCredits?: number }) {
    const user = this._users.get(userId);
    if (!user) {
      throw new Error('USER_NOT_FOUND');
    }
    if (patch.monthlyCredits !== undefined) {
      user.monthlyCredits = patch.monthlyCredits;
    }
    return {
      userId,
      allow: user.allow,
      monthlyCredits: user.monthlyCredits,
    };
  }

  async queryUsage(query: { userId?: string; provider?: string }) {
    return this._usageAggregator.listEvents(query);
  }

  async explainDecision(requestId: string): Promise<DecisionRecordMem[]> {
    return this._decisions.filter((d) => d.requestId === requestId);
  }

  async listDecisions(): Promise<DecisionRecordMem[]> {
    return [...this._decisions];
  }
}
