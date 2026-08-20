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
/** SQLite signed 64-bit 上界（9_223_372_036_854_775_807）。 */
export const MAX_SIGNED_64BIT = 9223372036854775807n;
/** SQLite signed 64-bit 下界（-9_223_372_036_854_775_808）。 */
const MIN_SIGNED_64BIT = -9223372036854775808n;
/** 1 Credit 的 nanos 倍率。 */
const NANOS_PER_CREDIT = 1000000000n;
/** 1x multiplier 对应的 ppm 值。 */
const PPM_PER_UNIT = 1000000n;
/**
 * 计算 attempt 的 credit_nanos 值。
 *
 * 计算过程使用 BigInt 以避免 Number 精度丢失，最终通过 ceil 取整。
 * - tokensPerCredit 必须为正有限数（>0）
 * - multiplierPpm 允许 0（免计费模型），不允许为负
 * - reasoningTokens 不参与求和，因为它已是 outputTokens 的子集
 */
export function computeCreditNanos(tokens, multiplierPpm, tokensPerCredit) {
    if (!Number.isFinite(tokensPerCredit) || tokensPerCredit <= 0) {
        throw new RangeError(`INVALID_TOKENS_PER_CREDIT: ${tokensPerCredit}`);
    }
    if (!Number.isFinite(multiplierPpm) || multiplierPpm < 0) {
        throw new RangeError(`INVALID_MULTIPLIER_PPM: ${multiplierPpm}`);
    }
    // reasoningTokens 已是 outputTokens 的子集，不重复计入
    const totalTokens = tokens.inputTokens +
        tokens.outputTokens +
        (tokens.cacheReadTokens ?? 0) +
        (tokens.cacheWriteTokens ?? 0);
    // 转 BigInt 前先截断小数部分，避免 BigInt(number) 抛错
    const totalTokensBn = BigInt(Math.trunc(totalTokens));
    const multiplierPpmBn = BigInt(Math.trunc(multiplierPpm));
    const tokensPerCreditBn = BigInt(Math.trunc(tokensPerCredit));
    // 分子：total_tokens * multiplier_ppm * 1_000_000_000
    const numerator = totalTokensBn * multiplierPpmBn * NANOS_PER_CREDIT;
    // 分母：tokens_per_credit * 1_000_000
    const denominator = tokensPerCreditBn * PPM_PER_UNIT;
    // 0 token 或 0x multiplier 直接返回 0，避免无谓计算
    if (numerator <= 0n)
        return 0n;
    // ceil(a / b) for nonnegative a, b: (a + b - 1n) / b
    return (numerator + denominator - 1n) / denominator;
}
/** 将 Credit 数量转换为 nanos。1 Credit = 1_000_000_000 nanos。 */
export function creditsToNanos(credits) {
    if (!Number.isFinite(credits) || credits < 0) {
        throw new RangeError(`INVALID_CREDITS: ${credits}`);
    }
    // 拆分整数与小数部分，避免大数精度损失
    const integerPart = BigInt(Math.floor(credits));
    const fractionCredits = credits - Math.floor(credits);
    // 小数部分按 1e9 缩放并取整（容忍 IEEE 浮点误差）
    const fractionNanos = BigInt(Math.round(fractionCredits * 1_000_000_000));
    return integerPart * NANOS_PER_CREDIT + fractionNanos;
}
/** 将 nanos 反向转换为 Credit 数量（number）。大数会损失精度，仅供展示用。 */
export function nanosToCredits(nanos) {
    if (nanos < 0n) {
        throw new RangeError(`INVALID_NANOS: ${nanos}`);
    }
    // Number 在 2^53 内精确，超出会损失精度，但 Credit 展示可容忍
    const integerPart = Number(nanos / NANOS_PER_CREDIT);
    const fractionNanos = Number(nanos % NANOS_PER_CREDIT);
    return integerPart + fractionNanos / 1_000_000_000;
}
/**
 * 验证 nanos 值在 SQLite signed 64-bit 范围内。
 *
 * 入库前调用：超出 [-2^63, 2^63-1] 抛 RangeError，避免 SQLite INTEGER 溢出。
 */
export function validateNanosRange(nanos) {
    if (nanos < MIN_SIGNED_64BIT || nanos > MAX_SIGNED_64BIT) {
        throw new RangeError(`NANOS_OUT_OF_RANGE: ${nanos} not in [${MIN_SIGNED_64BIT}, ${MAX_SIGNED_64BIT}]`);
    }
}
