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
/**
 * 在指定时区下，将"年-月-日 时:分:秒.毫秒"视作该时区的本地时间，
 * 返回对应的 UTC Date。
 *
 * 实现：先用 Date.UTC 构造近似时间戳，再用 Intl.DateTimeFormat 反推偏移，
 * 最后减去偏移得到真实 UTC 时间戳。能正确处理 DST 切换。
 */
function zonedTimeToUtc(year, month, // 1-based
day, hour, minute, second, ms, timezone) {
    // Step 1：把目标本地时间视作 UTC，得到一个近似时间戳 U0
    const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    // Step 2：把 U0 格式化为目标时区的本地时间显示 P
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(new Date(asIfUtc));
    const get = (type) => {
        const p = parts.find((part) => part.type === type);
        if (!p)
            throw new Error(`DATETIME_PART_MISSING: ${type}`);
        return Number(p.value);
    };
    // hour12:false 在某些环境会把午夜显示为 "24"，统一归零
    let tzHour = get('hour');
    if (tzHour === 24)
        tzHour = 0;
    // Step 3：把显示 P 也视作 UTC，得到 P0
    const tzAsIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), tzHour, get('minute'), get('second'), ms);
    // Step 4：偏移 = P0 - U0；真实 UTC = U0 - 偏移
    const offset = tzAsIfUtc - asIfUtc;
    return new Date(asIfUtc - offset);
}
/**
 * 返回当前自然月的起止时间（按 IANA 时区）。
 *
 * - start：本月 1 日 00:00:00.000（在该时区）— 含下界
 * - end：下月 1 日 00:00:00.000（在该时区）— 独占上界
 *
 * 适合 SQLite 范围查询：`created_at >= start AND created_at < end`。
 */
export function monthWindow(timezone, at = new Date()) {
    // 取出目标时区下的年、月（基于 at 时刻）
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'numeric',
    }).formatToParts(at);
    const get = (type) => {
        const p = parts.find((part) => part.type === type);
        if (!p)
            throw new Error(`DATETIME_PART_MISSING: ${type}`);
        return Number(p.value);
    };
    const year = get('year');
    const month = get('month'); // 1-based
    // 本月 1 日 00:00:00.000（在该时区）
    const start = zonedTimeToUtc(year, month, 1, 0, 0, 0, 0, timezone);
    // 下月 1 日 00:00:00.000（在该时区）— 独占 end
    const nextMonthYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const end = zonedTimeToUtc(nextMonthYear, nextMonth, 1, 0, 0, 0, 0, timezone);
    return { start, end };
}
/**
 * 返回如 "2026-08" 的月份键，用于聚合或行键。
 *
 * 月份在指定时区下解释；两位补零。
 */
export function monthKey(timezone, at = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
    }).formatToParts(at);
    const get = (type) => {
        const p = parts.find((part) => part.type === type);
        if (!p)
            throw new Error(`DATETIME_PART_MISSING: ${type}`);
        return p.value;
    };
    return `${get('year')}-${get('month')}`;
}
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
export function checkQuota(usedNanos, limitNanos) {
    if (usedNanos < 0n)
        throw new RangeError(`INVALID_USED_NANOS: ${usedNanos}`);
    if (limitNanos < 0n)
        throw new RangeError(`INVALID_LIMIT_NANOS: ${limitNanos}`);
    const exceeded = usedNanos >= limitNanos;
    const remainingNanos = exceeded ? 0n : limitNanos - usedNanos;
    return {
        usedNanos,
        limitNanos,
        remainingNanos,
        exceeded,
    };
}
