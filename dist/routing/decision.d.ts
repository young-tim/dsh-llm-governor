import type { CanonicalRoute } from '../model/canonical.js';
import type { DecisionCandidate, ExclusionReason } from './types.js';
/** 规范常量：截断与序列化上限（版本化，见优化文档 7.1）。 */
export declare const DECISION_LIMITS: {
    /** 候选最多保存项数。 */
    readonly maxCandidates: 64;
    /** 排除项最多保存项数。 */
    readonly maxExcluded: 128;
    /** 单个 Decision Event 的 UTF-8 序列化上限（字节）。 */
    readonly maxEventBytes: number;
};
/** 允许出现在 changedFields 的固定枚举。 */
export declare const CHANGED_FIELDS: readonly ["selection_mode", "strategy", "classification", "minimum_quality", "selected_route", "config_revision", "candidate_set"];
/** changedFields 的合法值类型。 */
export type ChangedField = (typeof CHANGED_FIELDS)[number];
/** trigger 兼容字段按该优先级取最高（causes 保存全部原因）。 */
export declare const TRIGGER_PRIORITY: readonly ["fallback", "selection_mode_change", "config_change", "resume", "initial", "step"];
/** 决策原因（causes 元素）。 */
export type DecisionCause = 'initial' | 'resume' | 'step' | 'selection_mode_change' | 'config_change' | 'fallback';
/**
 * 生成 UUIDv7（48 bit 毫秒时间戳 + 版本/变体位 + 随机位）。
 *
 * 用于 requestId：同一逻辑模型请求首次进入路由时生成，middleware 重入、
 * Fallback 与乱序回调复用同一 ID。
 *
 * @returns 小写十六进制 UUIDv7 字符串。
 */
export declare function uuidv7(): string;
/**
 * RFC 8785 JSON Canonicalization Scheme 规范化。
 *
 * 对纯 JSON 值（string/number/boolean/null/array/object）递归按字典序排序
 * object key 后序列化；数字与字符串沿用 JSON.stringify 的 ECMAScript 语义
 * （与 RFC 8785 的 Number::toString / 字符串转义一致）。不支持 BigInt 等
 * 非 JSON 值（调用方保证输入为纯 JSON）。
 *
 * @param value - 纯 JSON 值。
 * @returns 规范化 JSON 文本。
 */
export declare function canonicalizeJson(value: unknown): string;
/** 参与 decisionHash 比较的核心字段集合（双写一致性比较面）。 */
export interface DecisionHashInput {
    /** 事件 schema 版本。 */
    schemaVersion: number;
    /** 幂等键。 */
    decisionId: string;
    requestId: string;
    turn: number;
    step: number;
    fallbackIndex: number;
    trigger: string;
    causes: readonly string[];
    changedFields: readonly string[];
    selectionMode: string;
    effectiveStrategy: string;
    classifier?: {
        taskType: string;
        complexity: string;
        confidence: number;
        source: string;
    } | undefined;
    minimumQuality?: number | undefined;
    candidates: readonly DecisionCandidate[];
    excluded: ReadonlyArray<{
        routeId: string;
        reason: string;
    }>;
    outcome: string;
    selectedRoute?: string | undefined;
    errorCode?: string | undefined;
    configRevision: number;
}
/**
 * 计算 decisionHash：核心字段 JCS 规范化后 SHA-256 小写十六进制。
 *
 * @param input - 参与比较的核心字段（截断后的最终形态）。
 * @returns 64 字符小写十六进制摘要。
 */
export declare function computeDecisionHash(input: DecisionHashInput): string;
/** 截断后的候选/排除集合与截断元数据。 */
export interface TruncationResult<T> {
    /** 截断（或原样）后的列表。 */
    items: readonly T[];
    /** 截断前的总数。 */
    totalCount: number;
    /** 是否发生截断。 */
    truncated: boolean;
    /** 截断丢弃内容的 SHA-256 摘要（发生截断时存在）。 */
    truncatedDigest?: string;
}
/**
 * 按传入顺序截断列表并记录截断元数据。
 *
 * @param items - 原始列表（调用方保证已按决策排序顺序排列）。
 * @param max - 最大保留项数。
 * @returns 截断结果。
 */
export declare function truncateList<T>(items: readonly T[], max: number): TruncationResult<T>;
/**
 * 按 causes 归并出兼容 trigger 字段（最高优先级胜出）。
 *
 * @param causes - 全部发生原因。
 * @returns 兼容 trigger。
 */
export declare function deriveTrigger(causes: readonly DecisionCause[]): (typeof TRIGGER_PRIORITY)[number];
/**
 * 校验 changedFields 只允许固定枚举。
 *
 * @param fields - 待校验字段列表。
 * @throws 未知字段时抛错（fail closed）。
 */
export declare function assertChangedFields(fields: readonly string[]): asserts fields is readonly ChangedField[];
/** 构造完成的不可变决策（含哈希与截断元数据）。 */
export interface SealedDecision {
    /** 幂等键 `<requestId>:<fallbackIndex>`。 */
    decisionId: string;
    /** 核心字段 JCS SHA-256 摘要。 */
    decisionHash: string;
    requestId: string;
    turn: number;
    step: number;
    fallbackIndex: number;
    /** 兼容 trigger（causes 最高优先级）。 */
    trigger: (typeof TRIGGER_PRIORITY)[number];
    causes: readonly DecisionCause[];
    changedFields: readonly ChangedField[];
    selectionMode: 'manual' | 'auto';
    effectiveStrategy: 'manual' | 'quality_first' | 'credit_first';
    classifier?: {
        taskType: string;
        complexity: string;
        confidence: number;
        source: 'hint' | 'rule' | 'llm';
    };
    minimumQuality?: number;
    candidates: readonly DecisionCandidate[];
    excluded: ReadonlyArray<{
        routeId: CanonicalRoute;
        reason: ExclusionReason;
    }>;
    outcome: 'selected' | 'rejected';
    selectedRoute?: CanonicalRoute;
    errorCode?: string;
    configRevision: number;
    createdAt: string;
    /** 截断元数据。 */
    candidateTruncation: TruncationResult<DecisionCandidate>;
    excludedTruncation: TruncationResult<{
        routeId: CanonicalRoute;
        reason: ExclusionReason;
    }>;
}
/** 构造 SealedDecision 的输入（未截断的原始决策内容）。 */
export interface SealDecisionInput {
    requestId: string;
    turn: number;
    step: number;
    fallbackIndex: number;
    causes: readonly DecisionCause[];
    changedFields: readonly string[];
    selectionMode: 'manual' | 'auto';
    effectiveStrategy: 'manual' | 'quality_first' | 'credit_first';
    classifier?: {
        taskType: string;
        complexity: string;
        confidence: number;
        source: 'hint' | 'rule' | 'llm';
    };
    minimumQuality?: number;
    candidates: readonly DecisionCandidate[];
    excluded: ReadonlyArray<{
        routeId: CanonicalRoute;
        reason: ExclusionReason;
    }>;
    outcome: 'selected' | 'rejected';
    selectedRoute?: CanonicalRoute;
    errorCode?: string;
    configRevision: number;
}
/** 事件 schema 版本（与 GOVERNOR_SESSION_EVENT_SCHEMA_VERSION 对齐）。 */
export declare const DECISION_SCHEMA_VERSION = 1;
/**
 * 构造一个不可变决策：校验 changedFields、截断候选/排除、归并 trigger、
 * 计算 decisionHash，并 deepFreeze 全部字段。
 *
 * @param input - 原始决策内容。
 * @returns 冻结的 SealedDecision。
 */
export declare function sealDecision(input: SealDecisionInput): SealedDecision;
/**
 * 校验事件的 UTF-8 序列化大小不超过 64 KiB 上限。
 *
 * @param payload - 待序列化的事件数据。
 * @throws 超限时抛错（调用方须进一步截断后重试或 fail closed）。
 */
export declare function assertEventSize(payload: unknown): void;
