/** 可注册的策略名集合。 */
const STRATEGY_NAMES = new Set(['quality_first', 'credit_first', 'auto']);
/**
 * Governor 扩展注册表。
 *
 * 单实例挂载在 GovernorService.extensions 上；四个扩展点各自独立注册/注销，
 * 未注册时系统使用内置实现。除 RoutingStrategy 按 name 索引外，其余扩展点为
 * 单槽位（后注册者覆盖先注册者）。
 */
export class GovernorExtensionRegistry {
    _identityProvider;
    _taskClassifier;
    _routingStrategies = new Map();
    _modelQualityProvider;
    // ===== IdentityProvider =====
    /**
     * 注册自定义身份提供者（identity.provider=custom 时生效）。
     * @param provider - 提供者实例，kind 必须非空（用于诊断与日志）。
     */
    registerIdentityProvider(provider) {
        if (typeof provider.kind !== 'string' || provider.kind.length === 0) {
            throw new Error('EXTENSION_INVALID_IDENTITY_PROVIDER');
        }
        this._identityProvider = provider;
    }
    /** 注销自定义身份提供者。 */
    unregisterIdentityProvider() {
        this._identityProvider = undefined;
    }
    /** 获取已注册的自定义身份提供者。 */
    getIdentityProvider() {
        return this._identityProvider;
    }
    // ===== TaskClassifier =====
    /** 注册自定义任务分类器（替换内置 Hint → Rule → LLM 编排）。 */
    registerTaskClassifier(classifier) {
        this._taskClassifier = classifier;
    }
    /** 注销自定义任务分类器。 */
    unregisterTaskClassifier() {
        this._taskClassifier = undefined;
    }
    /** 获取已注册的自定义任务分类器。 */
    getTaskClassifier() {
        return this._taskClassifier;
    }
    // ===== RoutingStrategy =====
    /**
     * 注册自定义路由策略。
     * @param strategy - 策略实例；name 必须是 quality_first | credit_first | auto，
     *   注册后按 name 接管该模式的路由决策（manual 不允许接管）。
     */
    registerRoutingStrategy(strategy) {
        if (typeof strategy.name !== 'string' || !STRATEGY_NAMES.has(strategy.name)) {
            throw new Error('EXTENSION_INVALID_ROUTING_STRATEGY');
        }
        this._routingStrategies.set(strategy.name, strategy);
    }
    /** 注销自定义路由策略。 */
    unregisterRoutingStrategy(name) {
        this._routingStrategies.delete(name);
    }
    /** 按名获取已注册的自定义路由策略。 */
    getRoutingStrategy(name) {
        return this._routingStrategies.get(name);
    }
    /** 列出已注册路由策略的 name。 */
    listRoutingStrategyNames() {
        return [...this._routingStrategies.keys()];
    }
    // ===== ModelQualityProvider =====
    /** 注册自定义模型质量提供者（按维度覆盖治理配置中的 Quality）。 */
    registerModelQualityProvider(provider) {
        this._modelQualityProvider = provider;
    }
    /** 注销自定义模型质量提供者。 */
    unregisterModelQualityProvider() {
        this._modelQualityProvider = undefined;
    }
    /** 获取已注册的自定义模型质量提供者。 */
    getModelQualityProvider() {
        return this._modelQualityProvider;
    }
}
