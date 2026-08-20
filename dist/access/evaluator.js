/**
 * 评估用户对特定 route 的访问权限。
 * @param routeId - 要检查的 canonical route。
 * @param userPolicy - 用户策略（undefined 表示无用户策略，使用全局默认）。
 * @param globalDefault - 全局默认可用 route 集合。
 * @returns Access 检查结果。
 */
export function evaluateAccess(routeId, userPolicy, globalDefault) {
    if (userPolicy && userPolicy.allow.length > 0) {
        // 非空 allow list：只允许显式 route_id
        if (!userPolicy.allow.includes(routeId)) {
            return { allowed: false, reason: 'not_in_allow_list' };
        }
        return { allowed: true, reason: 'ok' };
    }
    // 空 allow list：使用全局默认
    if (!globalDefault.has(routeId)) {
        return { allowed: false, reason: 'not_in_global_default' };
    }
    return { allowed: true, reason: 'ok' };
}
/**
 * 批量过滤候选 route，返回允许的子集。
 * @param candidates - 候选 route id 列表。
 * @param userPolicy - 用户策略。
 * @param globalDefault - 全局默认可用 route 集合。
 * @returns 允许的 route id 列表。
 */
export function filterByAccess(candidates, userPolicy, globalDefault) {
    return candidates.filter((routeId) => evaluateAccess(routeId, userPolicy, globalDefault).allowed);
}
