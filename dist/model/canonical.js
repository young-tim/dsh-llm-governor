/**
 * 构造 canonical route id。
 * @param provider - provider 路由键。
 * @param model - 模型 id。
 * @returns `provider:model`。
 */
export function canonicalRoute(provider, model) {
    return `${provider}:${model}`;
}
/**
 * 解析 canonical route id。
 * @param routeId - `provider:model` 格式的 route id。
 * @returns 解析后的 provider 和 model。
 * @throws 如果 route id 格式无效。
 */
export function parseRoute(routeId) {
    const idx = routeId.indexOf(':');
    if (idx <= 0 || idx >= routeId.length - 1) {
        throw new Error(`INVALID_ROUTE_ID: ${routeId}`);
    }
    return {
        provider: routeId.slice(0, idx),
        model: routeId.slice(idx + 1),
    };
}
/**
 * 合并 DSH advisory 与治理策略，生成不可变 ModelSnapshot。
 * 治理配置中存在、目录中缺席的模型可以保留，但其 Provider 必须活动。
 * 未配置 Multiplier 使用 1x（1_000_000 ppm）。
 */
export function mergeModel(advisory, policy) {
    // 两者都缺失则返回 undefined
    if (!advisory && !policy)
        return undefined;
    const provider = advisory?.provider ?? policy?.provider;
    const model = advisory?.id ?? policy?.model;
    if (!provider || !model)
        return undefined;
    const routeId = canonicalRoute(provider, model);
    return {
        routeId,
        provider,
        model,
        enabled: policy?.enabled ?? true,
        multiplierPpm: policy?.multiplierPpm ?? 1_000_000,
        capabilities: policy?.capabilities ?? [],
        quality: policy?.quality ?? {},
        name: advisory?.name ?? model,
        inAdvisory: !!advisory,
        ...(advisory?.description ? { description: advisory.description } : {}),
        ...(advisory?.inputModalities ? { inputModalities: advisory.inputModalities } : {}),
    };
}
/**
 * 解析裸 model id 到 canonical route。
 * 只有在活动 Provider 中唯一时才解析；冲突时返回 'AMBIGUOUS_MODEL_ROUTE'。
 * @param modelId - 裸 model id（不含 provider 前缀）。
 * @param activeProviders - 活动 provider 列表及其 advisory 模型。
 * @returns canonical route 或 'AMBIGUOUS_MODEL_ROUTE'。
 */
export function resolveBareModel(modelId, advisoryByProvider) {
    const matches = [];
    for (const [provider, models] of advisoryByProvider) {
        if (models.some((m) => m.id === modelId)) {
            matches.push(canonicalRoute(provider, modelId));
        }
    }
    if (matches.length === 0)
        return 'AMBIGUOUS_MODEL_ROUTE';
    if (matches.length > 1)
        return 'AMBIGUOUS_MODEL_ROUTE';
    return matches[0];
}
/**
 * 构建模型目录快照。
 * 合并 advisory 目录与 DB 策略，输出不可变 snapshot 列表。
 * @param advisoryByProvider - 每个活动 provider 的 advisory 模型列表。
 * @param policies - DB 中的治理策略。
 * @returns 合并后的模型快照列表。
 */
export function buildModelDirectory(advisoryByProvider, policies) {
    const result = [];
    const seen = new Set();
    // 先合并 advisory 中的模型
    for (const [, models] of advisoryByProvider) {
        for (const adv of models) {
            const routeId = canonicalRoute(adv.provider, adv.id);
            seen.add(routeId);
            const policy = policies.get(routeId);
            const snap = mergeModel(adv, policy);
            if (snap)
                result.push(snap);
        }
    }
    // 再加入 advisory 中缺席但 DB 中存在且 Provider 活动的策略
    for (const [routeId, policy] of policies) {
        if (seen.has(routeId))
            continue;
        // Provider 必须活动
        if (!advisoryByProvider.has(policy.provider))
            continue;
        const snap = mergeModel(undefined, policy);
        if (snap)
            result.push(snap);
    }
    return result;
}
