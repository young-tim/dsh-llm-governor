/**
 * Fallback 模块：错误分类、排除集、attempt 上限、部分输出保护。
 * 429/Timeout/5xx/Provider Unavailable → 可重试；
 * 401/403/用户取消/非法参数/内容安全/Context Window → 不可重试。
 */
import type { CanonicalRoute } from '../model/canonical.js';
/** 失败信息。 */
export interface FailureInfo {
    readonly code: string;
    readonly status?: number;
    readonly message: string;
}
/**
 * 判断失败是否可重试（429/Timeout/5xx/Provider Unavailable）。
 * 401/403/用户取消/非法参数/内容安全/Context Window 不可重试。
 */
export declare function isRetryable(failure: FailureInfo): boolean;
/** 请求级 fallback 状态。 */
export declare class FallbackState {
    private _excludedRoutes;
    private _attemptCount;
    private _partialOutputDelivered;
    private readonly _maxAttempts;
    private readonly _afterPartialOutput;
    constructor(maxAttempts: number, afterPartialOutput?: boolean);
    /** 排除失败路由。 */
    excludeRoute(routeId: CanonicalRoute): void;
    /** 获取已排除的路由集合。 */
    get excludedRoutes(): ReadonlySet<CanonicalRoute>;
    /** 记录一次 attempt。 */
    recordAttempt(): void;
    /** 当前 attempt 次数。 */
    get attemptCount(): number;
    /** 检查是否还能重试（attemptCount < maxAttempts）。 */
    canRetry(): boolean;
    /** 标记已交付首个语义 chunk。 */
    markPartialOutput(): void;
    /** 是否已交付部分输出。 */
    get partialOutputDelivered(): boolean;
    /**
     * 判断是否应该重试。
     * 默认在首个语义 chunk 后不切模型（after_partial_output=false）。
     */
    shouldRetry(failure: FailureInfo): boolean;
}
