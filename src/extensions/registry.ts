/**
 * 扩展注册表（需求基线 §6）：四个领域扩展点的运行时注册 API。
 *
 * - IdentityProvider：identity.provider=custom 时，入站绑定使用注册的自定义提供者。
 * - TaskClassifier：注册后替换内置 Hint → Rule → LLM 分类编排。
 * - RoutingStrategy：按 name 接管对应非 Manual 模式（及 Manual Fallback 重选）的路由决策。
 * - ModelQualityProvider：注册后对目录中的 Quality 画像按维度覆盖（显式来源，§20）。
 *
 * 领域层，不导入任何 DSH 包。注册表是进程内可变状态：扩展由第三方插件在每次
 * 加载时重新注册，重启后不持久化（扩展实现本身不属于治理数据）。
 * 第三方插件通过 ctx.governor.extensions 访问本注册表。
 */
import type { TaskType } from '../index.js';
import type { ClassifyInput, Classification } from '../classifier/types.js';
import type { GovernorIdentity, IdentityContext, IdentityProvider } from '../identity/types.js';
import type { CanonicalRoute } from '../model/canonical.js';
import type { FilterInput, RoutingResult } from '../routing/types.js';
import type { AutoClassification } from '../routing/strategies.js';

/** TaskClassifier 扩展点：替换内置分类编排（签名与内置 Classifier 一致）。 */
export interface TaskClassifier {
  /** 对输入执行分类，返回固定结构的 Classification。 */
  classify(input: ClassifyInput): Promise<Classification>;
}

/** 路由上下文：交给自定义 RoutingStrategy 的请求级信息。 */
export interface RoutingContext {
  /** 本次决策对应的路由模式（不含 manual：Manual 语义受产品保证保护）。 */
  readonly mode: 'quality_first' | 'credit_first' | 'auto';
  /** pre-step 缓存的分类结果（未分类时为 general/medium/0.5 默认值）。 */
  readonly classification: AutoClassification;
  /** credit_first 的最低质量阈值。 */
  readonly minimumQuality: number;
  /** credit_first 无候选时的回退策略。 */
  readonly onNoMatch: 'quality_first' | 'none';
  /** auto 的置信度阈值。 */
  readonly confidenceThreshold: number;
  /** auto 的复杂度 → 质量阈值。 */
  readonly qualityThresholds: { low: number; medium: number; high: number };
}

/** RoutingStrategy 扩展点：按 name 接管对应模式的路由决策。 */
export interface RoutingStrategy {
  /** 策略名：必须是 quality_first | credit_first | auto 之一。 */
  readonly name: 'quality_first' | 'credit_first' | 'auto';
  /** 执行路由选择；必须遵守公共候选过滤结果（input 内已含排除集与能力要求）。 */
  select(input: FilterInput, context: RoutingContext): RoutingResult;
}

/** ModelQualityProvider 扩展点：为模型提供 Quality 画像（按维度覆盖治理配置）。 */
export interface ModelQualityProvider {
  /** 返回 route 的 Quality 画像；返回的维度覆盖治理配置，其余维度沿用原值。 */
  getQuality(routeId: CanonicalRoute): Readonly<Partial<Record<TaskType, number>>>;
}

/** 身份解析扩展的输入（与 IdentityContext 一致，独立声明避免循环依赖）。 */
export type ExtensionIdentityContext = IdentityContext;

/** 身份解析扩展的返回（与 GovernorIdentity 一致）。 */
export type ExtensionIdentity = GovernorIdentity;

/** 可注册的策略名集合。 */
const STRATEGY_NAMES: ReadonlySet<string> = new Set(['quality_first', 'credit_first', 'auto']);

/**
 * Governor 扩展注册表。
 *
 * 单实例挂载在 GovernorService.extensions 上；四个扩展点各自独立注册/注销，
 * 未注册时系统使用内置实现。除 RoutingStrategy 按 name 索引外，其余扩展点为
 * 单槽位（后注册者覆盖先注册者）。
 */
export class GovernorExtensionRegistry {
  private _identityProvider: IdentityProvider | undefined;
  private _taskClassifier: TaskClassifier | undefined;
  private _routingStrategies = new Map<string, RoutingStrategy>();
  private _modelQualityProvider: ModelQualityProvider | undefined;

  // ===== IdentityProvider =====

  /**
   * 注册自定义身份提供者（identity.provider=custom 时生效）。
   * @param provider - 提供者实例，kind 必须非空（用于诊断与日志）。
   */
  registerIdentityProvider(provider: IdentityProvider): void {
    if (typeof provider.kind !== 'string' || provider.kind.length === 0) {
      throw new Error('EXTENSION_INVALID_IDENTITY_PROVIDER');
    }
    this._identityProvider = provider;
  }

  /** 注销自定义身份提供者。 */
  unregisterIdentityProvider(): void {
    this._identityProvider = undefined;
  }

  /** 获取已注册的自定义身份提供者。 */
  getIdentityProvider(): IdentityProvider | undefined {
    return this._identityProvider;
  }

  // ===== TaskClassifier =====

  /** 注册自定义任务分类器（替换内置 Hint → Rule → LLM 编排）。 */
  registerTaskClassifier(classifier: TaskClassifier): void {
    this._taskClassifier = classifier;
  }

  /** 注销自定义任务分类器。 */
  unregisterTaskClassifier(): void {
    this._taskClassifier = undefined;
  }

  /** 获取已注册的自定义任务分类器。 */
  getTaskClassifier(): TaskClassifier | undefined {
    return this._taskClassifier;
  }

  // ===== RoutingStrategy =====

  /**
   * 注册自定义路由策略。
   * @param strategy - 策略实例；name 必须是 quality_first | credit_first | auto，
   *   注册后按 name 接管该模式的路由决策（manual 不允许接管）。
   */
  registerRoutingStrategy(strategy: RoutingStrategy): void {
    if (typeof strategy.name !== 'string' || !STRATEGY_NAMES.has(strategy.name)) {
      throw new Error('EXTENSION_INVALID_ROUTING_STRATEGY');
    }
    this._routingStrategies.set(strategy.name, strategy);
  }

  /** 注销自定义路由策略。 */
  unregisterRoutingStrategy(name: string): void {
    this._routingStrategies.delete(name);
  }

  /** 按名获取已注册的自定义路由策略。 */
  getRoutingStrategy(name: string): RoutingStrategy | undefined {
    return this._routingStrategies.get(name);
  }

  /** 列出已注册路由策略的 name。 */
  listRoutingStrategyNames(): string[] {
    return [...this._routingStrategies.keys()];
  }

  // ===== ModelQualityProvider =====

  /** 注册自定义模型质量提供者（按维度覆盖治理配置中的 Quality）。 */
  registerModelQualityProvider(provider: ModelQualityProvider): void {
    this._modelQualityProvider = provider;
  }

  /** 注销自定义模型质量提供者。 */
  unregisterModelQualityProvider(): void {
    this._modelQualityProvider = undefined;
  }

  /** 获取已注册的自定义模型质量提供者。 */
  getModelQualityProvider(): ModelQualityProvider | undefined {
    return this._modelQualityProvider;
  }
}
