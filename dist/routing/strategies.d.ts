/**
 * 四种确定性路由策略：Manual、Quality First、Credit First、Auto。
 * 所有策略共享公共候选过滤，使用稳定排序和固定 tie-break。
 */
import type { TaskType, Complexity } from '../index.js';
import type { FilterInput, RoutingResult } from './types.js';
/**
 * Manual 策略：读取用户选择的 provider/model，解析 canonical route 后只做公共过滤。
 * 成功时原样返回该 route；失败时拒绝，绝不自动替换成另一个模型。
 */
export declare function routeManual(input: FilterInput, requestedProvider: string, requestedModel: string, configRevision?: number): RoutingResult;
/**
 * Quality First 策略：对当前 task_type 的 Quality 降序排序。
 * Tie-break：1. Multiplier 升序 2. canonical route 字典序。
 * 缺少该 task Quality 的模型被排除为 quality_missing。
 */
export declare function routeQualityFirst(input: FilterInput, taskType: TaskType, configRevision?: number): RoutingResult;
/**
 * Credit First 策略：先过滤 quality >= minimum_quality，再排序。
 * 排序：1. Multiplier 升序 2. Quality 降序 3. canonical route 字典序。
 * 无模型达标返回 NO_MODEL_MATCHED（除非配置 on_no_match: quality_first）。
 */
export declare function routeCreditFirst(input: FilterInput, taskType: TaskType, minimumQuality: number, configRevision?: number, onNoMatch?: 'quality_first' | 'none'): RoutingResult;
/** Auto 分类结果。 */
export interface AutoClassification {
    taskType: TaskType;
    complexity: Complexity;
    confidence: number;
    source: 'hint' | 'rule' | 'llm';
}
/**
 * Auto 策略：按分类结果选择。
 * 低于置信度阈值时切 Quality First。
 * 置信度达标时映射复杂度到 minimum_quality，再执行 Credit First。
 */
export declare function routeAuto(input: FilterInput, classification: AutoClassification, confidenceThreshold: number, qualityThresholds?: {
    low: number;
    medium: number;
    high: number;
}, configRevision?: number): RoutingResult;
