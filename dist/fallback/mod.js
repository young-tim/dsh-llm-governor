/** 可重试的失败码。 */
const RETRYABLE_CODES = new Set([
    'RATE_LIMIT',
    'TIMEOUT',
    'SERVER_ERROR',
    'SERVICE_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE',
    'EMPTY_RESPONSE',
    'TRANSPORT_UNAVAILABLE',
]);
/** 不可重试的 HTTP 状态码。 */
const NON_RETRYABLE_STATUS = new Set([401, 403]);
/**
 * 判断失败是否可重试（429/Timeout/5xx/Provider Unavailable）。
 * 401/403/用户取消/非法参数/内容安全/Context Window 不可重试。
 */
export function isRetryable(failure) {
    // 401/403 不可重试
    if (failure.status !== undefined && NON_RETRYABLE_STATUS.has(failure.status))
        return false;
    // 检查已知可重试码
    if (RETRYABLE_CODES.has(failure.code))
        return true;
    // 5xx 可重试
    if (failure.status !== undefined && failure.status >= 500 && failure.status < 600)
        return true;
    // 429 可重试
    if (failure.status === 429)
        return true;
    return false;
}
/** 请求级 fallback 状态。 */
export class FallbackState {
    _excludedRoutes = new Set();
    _attemptCount = 0;
    _partialOutputDelivered = false;
    _maxAttempts;
    _afterPartialOutput;
    constructor(maxAttempts, afterPartialOutput = false) {
        this._maxAttempts = maxAttempts;
        this._afterPartialOutput = afterPartialOutput;
    }
    /** 排除失败路由。 */
    excludeRoute(routeId) {
        this._excludedRoutes.add(routeId);
    }
    /** 获取已排除的路由集合。 */
    get excludedRoutes() {
        return this._excludedRoutes;
    }
    /** 记录一次 attempt。 */
    recordAttempt() {
        this._attemptCount++;
    }
    /** 当前 attempt 次数。 */
    get attemptCount() {
        return this._attemptCount;
    }
    /** 检查是否还能重试（attemptCount < maxAttempts）。 */
    canRetry() {
        return this._attemptCount < this._maxAttempts;
    }
    /** 标记已交付首个语义 chunk。 */
    markPartialOutput() {
        this._partialOutputDelivered = true;
    }
    /** 是否已交付部分输出。 */
    get partialOutputDelivered() {
        return this._partialOutputDelivered;
    }
    /**
     * 判断是否应该重试。
     * 默认在首个语义 chunk 后不切模型（after_partial_output=false）。
     */
    shouldRetry(failure) {
        if (!isRetryable(failure))
            return false;
        if (!this.canRetry())
            return false;
        if (this._partialOutputDelivered && !this._afterPartialOutput)
            return false;
        return true;
    }
}
