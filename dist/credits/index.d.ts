/**
 * Credits 与 Quota 模块入口。
 *
 * 领域层模块：不导入任何 DSH 包。所有导出来自 calc.ts 与 quota.ts。
 */
export type { TokenCounts } from './calc.js';
export { computeCreditNanos, creditsToNanos, nanosToCredits, validateNanosRange, MAX_SIGNED_64BIT, } from './calc.js';
export type { QuotaConfig, QuotaStatus } from './quota.js';
export { monthWindow, monthKey, checkQuota } from './quota.js';
