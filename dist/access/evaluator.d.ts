/**
 * Access 评估器：控制用户对模型的访问。
 * 用户 allow list 为空表示使用全局默认可用模型；非空表示只允许显式 route_id。
 * Manual、Auto、Fallback 使用同一 AccessEvaluator，没有旁路。
 */
import type { CanonicalRoute } from '../model/canonical.js';
/** 用户策略。 */
export interface UserAccessPolicy {
    readonly userId: string;
    /** 空=使用全局默认；非空=只允许显式 route_id。 */
    readonly allow: readonly CanonicalRoute[];
}
/** Access 检查结果。 */
export interface AccessResult {
    readonly allowed: boolean;
    readonly reason: 'ok' | 'not_in_allow_list' | 'not_in_global_default';
}
/**
 * 评估用户对特定 route 的访问权限。
 * @param routeId - 要检查的 canonical route。
 * @param userPolicy - 用户策略（undefined 表示无用户策略，使用全局默认）。
 * @param globalDefault - 全局默认可用 route 集合。
 * @returns Access 检查结果。
 */
export declare function evaluateAccess(routeId: CanonicalRoute, userPolicy: UserAccessPolicy | undefined, globalDefault: ReadonlySet<CanonicalRoute>): AccessResult;
/**
 * 批量过滤候选 route，返回允许的子集。
 * @param candidates - 候选 route id 列表。
 * @param userPolicy - 用户策略。
 * @param globalDefault - 全局默认可用 route 集合。
 * @returns 允许的 route id 列表。
 */
export declare function filterByAccess(candidates: readonly CanonicalRoute[], userPolicy: UserAccessPolicy | undefined, globalDefault: ReadonlySet<CanonicalRoute>): CanonicalRoute[];
