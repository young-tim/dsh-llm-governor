/**
 * Canonical route 与模型目录合并。
 * route_id = provider + ":" + model，所有配置、Access、Usage 使用 route_id。
 */
import type { TaskType } from '../index.js';
/** Canonical route id：`provider:model`。 */
export type CanonicalRoute = string;
/** DSH advisory 模型信息（来自 listModels）。 */
export interface AdvisoryModelInfo {
    readonly provider: string;
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly inputModalities?: readonly string[];
}
/** 治理模型策略（DB 权威）。 */
export interface ModelPolicyEntry {
    readonly routeId: CanonicalRoute;
    readonly provider: string;
    readonly model: string;
    readonly enabled: boolean;
    readonly multiplierPpm: number;
    readonly capabilities: readonly string[];
    readonly quality: Readonly<Partial<Record<TaskType, number>>>;
}
/** 合并后的模型快照（advisory + 治理策略）。 */
export interface ModelSnapshot {
    readonly routeId: CanonicalRoute;
    readonly provider: string;
    readonly model: string;
    readonly enabled: boolean;
    readonly multiplierPpm: number;
    readonly capabilities: readonly string[];
    readonly quality: Readonly<Partial<Record<TaskType, number>>>;
    readonly name: string;
    readonly description?: string;
    readonly inputModalities?: readonly string[];
    readonly inAdvisory: boolean;
}
/**
 * 构造 canonical route id。
 * @param provider - provider 路由键。
 * @param model - 模型 id。
 * @returns `provider:model`。
 */
export declare function canonicalRoute(provider: string, model: string): CanonicalRoute;
/**
 * 解析 canonical route id。
 * @param routeId - `provider:model` 格式的 route id。
 * @returns 解析后的 provider 和 model。
 * @throws 如果 route id 格式无效。
 */
export declare function parseRoute(routeId: CanonicalRoute): {
    provider: string;
    model: string;
};
/**
 * 合并 DSH advisory 与治理策略，生成不可变 ModelSnapshot。
 * 治理配置中存在、目录中缺席的模型可以保留，但其 Provider 必须活动。
 * 未配置 Multiplier 使用 1x（1_000_000 ppm）。
 */
export declare function mergeModel(advisory: AdvisoryModelInfo | undefined, policy: ModelPolicyEntry | undefined): ModelSnapshot | undefined;
/**
 * 解析裸 model id 到 canonical route。
 * 只有在活动 Provider 中唯一时才解析；冲突时返回 'AMBIGUOUS_MODEL_ROUTE'。
 * @param modelId - 裸 model id（不含 provider 前缀）。
 * @param activeProviders - 活动 provider 列表及其 advisory 模型。
 * @returns canonical route 或 'AMBIGUOUS_MODEL_ROUTE'。
 */
export declare function resolveBareModel(modelId: string, advisoryByProvider: ReadonlyMap<string, readonly AdvisoryModelInfo[]>): CanonicalRoute | 'AMBIGUOUS_MODEL_ROUTE';
/**
 * 构建模型目录快照。
 * 合并 advisory 目录与 DB 策略，输出不可变 snapshot 列表。
 * @param advisoryByProvider - 每个活动 provider 的 advisory 模型列表。
 * @param policies - DB 中的治理策略。
 * @returns 合并后的模型快照列表。
 */
export declare function buildModelDirectory(advisoryByProvider: ReadonlyMap<string, readonly AdvisoryModelInfo[]>, policies: ReadonlyMap<string, ModelPolicyEntry>): readonly ModelSnapshot[];
