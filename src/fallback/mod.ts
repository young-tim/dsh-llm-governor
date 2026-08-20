/**
 * Fallback 模块：错误分类、排除集、attempt 上限、部分输出保护。
 * 429/Timeout/5xx/Provider Unavailable → 可重试；
 * 401/403/用户取消/非法参数/内容安全/Context Window → 不可重试。
 */
import type { CanonicalRoute } from '../model/canonical.js';

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
export function isRetryable(failure: FailureInfo): boolean {
  // 401/403 不可重试
  if (failure.status !== undefined && NON_RETRYABLE_STATUS.has(failure.status)) return false;
  // 检查已知可重试码
  if (RETRYABLE_CODES.has(failure.code)) return true;
  // 5xx 可重试
  if (failure.status !== undefined && failure.status >= 500 && failure.status < 600) return true;
  // 429 可重试
  if (failure.status === 429) return true;
  return false;
}

/** 请求级 fallback 状态。 */
export class FallbackState {
  private _excludedRoutes = new Set<CanonicalRoute>();
  private _attemptCount = 0;
  private _partialOutputDelivered = false;
  private readonly _maxAttempts: number;
  private readonly _afterPartialOutput: boolean;

  constructor(maxAttempts: number, afterPartialOutput = false) {
    this._maxAttempts = maxAttempts;
    this._afterPartialOutput = afterPartialOutput;
  }

  /** 排除失败路由。 */
  excludeRoute(routeId: CanonicalRoute): void {
    this._excludedRoutes.add(routeId);
  }

  /** 获取已排除的路由集合。 */
  get excludedRoutes(): ReadonlySet<CanonicalRoute> {
    return this._excludedRoutes;
  }

  /** 记录一次 attempt。 */
  recordAttempt(): void {
    this._attemptCount++;
  }

  /** 当前 attempt 次数。 */
  get attemptCount(): number {
    return this._attemptCount;
  }

  /** 检查是否还能重试（attemptCount < maxAttempts）。 */
  canRetry(): boolean {
    return this._attemptCount < this._maxAttempts;
  }

  /** 标记已交付首个语义 chunk。 */
  markPartialOutput(): void {
    this._partialOutputDelivered = true;
  }

  /** 是否已交付部分输出。 */
  get partialOutputDelivered(): boolean {
    return this._partialOutputDelivered;
  }

  /**
   * 判断是否应该重试。
   * 默认在首个语义 chunk 后不切模型（after_partial_output=false）。
   */
  shouldRetry(failure: FailureInfo): boolean {
    if (!isRetryable(failure)) return false;
    if (!this.canRetry()) return false;
    if (this._partialOutputDelivered && !this._afterPartialOutput) return false;
    return true;
  }
}
