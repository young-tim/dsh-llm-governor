/** Public, provider-neutral contracts for the implementation scaffold. */
export declare const name = "dsh-llm-governor";
export declare const TASK_TYPES: readonly ["general", "coding", "reasoning", "writing", "data_analysis", "vision", "tool_use"];
export type TaskType = (typeof TASK_TYPES)[number];
export type Complexity = 'low' | 'medium' | 'high';
export type RoutingMode = 'manual' | 'quality_first' | 'credit_first' | 'auto';
export interface ModelRoute {
    /** Registered DSH provider route. */
    provider: string;
    /** Provider-owned model id. */
    model: string;
}
export interface ModelPolicy extends ModelRoute {
    enabled: boolean;
    /** Fixed-point parts per million; 1x = 1_000_000. */
    multiplierPpm: number;
    capabilities: readonly string[];
    quality: Readonly<Partial<Record<TaskType, number>>>;
}
/** GovernorIdentity 的权威定义在 identity 领域模块。 */
export type { GovernorIdentity } from './identity/types.js';
export interface Classification {
    taskType: TaskType;
    complexity: Complexity;
    confidence: number;
    source: 'hint' | 'rule' | 'llm';
}
export interface RoutingSelection {
    requestId: string;
    mode: RoutingMode;
    selected: ModelRoute;
    classification?: Classification;
    fallbackIndex: number;
}
