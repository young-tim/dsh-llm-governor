/**
 * Credits 计算：基于 BigInt 的定点换算。
 *
 * 关键不变量（见 docs/TECHNICAL_DESIGN.md §9.1）：
 * - Multiplier 保存为 parts-per-million：1x = 1_000_000 ppm
 * - Credits 保存为 credit_nanos：1 Credit = 1_000_000_000 nanos
 * - 计量公式：total_tokens = input + cache_read + cache_write + output
 *   （reasoningTokens 已包含在 outputTokens 内，不重复累计）
 * - credit_nanos = ceil(total_tokens * multiplier_ppm * 1_000_000_000
 *                       / tokens_per_credit / 1_000_000)
 *
 * 该模块为领域层，不导入任何 DSH 包。
 */
/** 单次 attempt 的 Token 计量。reasoningTokens 是 outputTokens 的子集。 */
export interface TokenCounts {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
/** SQLite signed 64-bit 上界（9_223_372_036_854_775_807）。 */
export declare const MAX_SIGNED_64BIT = 9223372036854775807n;
/**
 * 计算 attempt 的 credit_nanos 值。
 *
 * 计算过程使用 BigInt 以避免 Number 精度丢失，最终通过 ceil 取整。
 * - tokensPerCredit 必须为正有限数（>0）
 * - multiplierPpm 允许 0（免计费模型），不允许为负
 * - reasoningTokens 不参与求和，因为它已是 outputTokens 的子集
 */
export declare function computeCreditNanos(tokens: TokenCounts, multiplierPpm: number, tokensPerCredit: number): bigint;
/** 将 Credit 数量转换为 nanos。1 Credit = 1_000_000_000 nanos。 */
export declare function creditsToNanos(credits: number): bigint;
/** 将 nanos 反向转换为 Credit 数量（number）。大数会损失精度，仅供展示用。 */
export declare function nanosToCredits(nanos: bigint): number;
/**
 * 验证 nanos 值在 SQLite signed 64-bit 范围内。
 *
 * 入库前调用：超出 [-2^63, 2^63-1] 抛 RangeError，避免 SQLite INTEGER 溢出。
 */
export declare function validateNanosRange(nanos: bigint): void;
