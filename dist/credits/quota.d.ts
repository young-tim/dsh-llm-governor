/**
 * 月度 Quota：admission control 与自然月窗口计算。
 *
 * 关键语义（见 docs/TECHNICAL_DESIGN.md §9.2）：
 * - 按配置的 IANA 时区计算自然月窗口，默认 UTC
 * - 额度是 admission control：每个实际 attempt 开始前读取已提交 Credits；
 *   若 used >= limit，拒绝调用
 * - 已在途的请求不被截断，因此并发请求可能让最终值略高于额度
 *
 * 该模块为领域层，不导入任何 DSH 包。使用 Intl.DateTimeFormat 处理时区。
 */
/** Quota 配置：时区与默认月度额度。 */
export interface QuotaConfig {
    /** IANA 时区，例如 "UTC" 或 "Asia/Shanghai"。 */
    timezone: string;
    /** 默认月度额度（credit_nanos）。 */
    defaultMonthlyCreditNanos: bigint;
}
/** 月度 Quota 准入状态。所有数值以 credit_nanos 表示。 */
export interface QuotaStatus {
    usedNanos: bigint;
    limitNanos: bigint;
    remainingNanos: bigint;
    exceeded: boolean;
}
/**
 * 返回当前自然月的起止时间（按 IANA 时区）。
 *
 * - start：本月 1 日 00:00:00.000（在该时区）— 含下界
 * - end：下月 1 日 00:00:00.000（在该时区）— 独占上界
 *
 * 适合 SQLite 范围查询：`created_at >= start AND created_at < end`。
 */
export declare function monthWindow(timezone: string, at?: Date): {
    start: Date;
    end: Date;
};
/**
 * 返回如 "2026-08" 的月份键，用于聚合或行键。
 *
 * 月份在指定时区下解释；两位补零。
 */
export declare function monthKey(timezone: string, at?: Date): string;
/**
 * Admission control 检查：当前已用量是否超出额度。
 *
 * - `used >= limit` 视为超限（exceeded=true），remaining=0
 * - 否则 remaining = limit - used
 * - 入参均以 credit_nanos 表示，bigint 运算避免精度问题
 *
 * 注意：本函数只做"读已提交"判断，不保证最终值不超额。
 * 并发请求可能让最终值略高于额度，这是 admission control 的已知语义。
 */
export declare function checkQuota(usedNanos: bigint, limitNanos: bigint): QuotaStatus;
