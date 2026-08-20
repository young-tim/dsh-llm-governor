/**
 * Credits 模块单元测试：验证 BigInt 计算、ceil 语义、单位换算、
 * 64-bit 范围校验、月度 Quota 窗口与 admission control。
 */
import { describe, it, expect } from 'vitest';
import {
  computeCreditNanos,
  creditsToNanos,
  nanosToCredits,
  validateNanosRange,
  MAX_SIGNED_64BIT,
  monthWindow,
  monthKey,
  checkQuota,
} from '../../src/credits/index.js';

describe('credits/computeCreditNanos', () => {
  it('3 tokens * 1x multiplier / 1_000_000 tpc = 3000 nanos（BigInt 精确）', () => {
    const nanos = computeCreditNanos(
      { inputTokens: 3, outputTokens: 0 },
      1_000_000, // 1x = 1_000_000 ppm
      1_000_000,
    );
    // 3 tokens / 1M tpc = 3e-6 Credit；3e-6 * 1e9 nanos = 3000 nanos
    expect(nanos).toBe(3000n);
  });

  it('整除情形：1 token * 1x / 1_000_000 tpc = 1000 nanos', () => {
    const nanos = computeCreditNanos({ inputTokens: 1, outputTokens: 0 }, 1_000_000, 1_000_000);
    // 1 token / 1M tpc = 1e-6 Credit = 1000 nanos
    expect(nanos).toBe(1000n);
  });

  it('ceil 语义：1 token * 1x / 3 tpc 向上取整到 333_333_334 nanos', () => {
    // 1/3 Credit = 333_333_333.33... nanos，ceil = 333_333_334
    const nanos = computeCreditNanos({ inputTokens: 1, outputTokens: 0 }, 1_000_000, 3);
    expect(nanos).toBe(333_333_334n);
  });

  it('reasoningTokens 是 outputTokens 的子集，不重复计入', () => {
    // 不带 reasoning
    const withoutReasoning = computeCreditNanos(
      { inputTokens: 10, outputTokens: 20 },
      1_000_000,
      1_000_000,
    );
    // 带 reasoning=5（已被包含在 outputTokens=20 内）
    const withReasoning = computeCreditNanos(
      { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
      1_000_000,
      1_000_000,
    );
    // total_tokens 都应是 30；nanos = 30 * 1e9 / 1e12 = 30_000
    expect(withoutReasoning).toBe(30_000n);
    expect(withReasoning).toBe(30_000n);
    // 若重复计入，withReasoning 会是 35_000n
    expect(withReasoning).not.toBe(35_000n);
  });

  it('cache_read + cache_write 计入 total_tokens', () => {
    const nanos = computeCreditNanos(
      {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
      },
      1_000_000,
      1_000_000,
    );
    // total = 4 tokens → 4 * 1e9 / 1e12 = 4000 nanos
    expect(nanos).toBe(4000n);
  });

  it('0 multiplier（免计费模型）→ credit_nanos = 0', () => {
    const nanos = computeCreditNanos(
      { inputTokens: 999, outputTokens: 999 },
      0, // 0x
      1_000_000,
    );
    expect(nanos).toBe(0n);
  });

  it('0 tokens → credit_nanos = 0', () => {
    const nanos = computeCreditNanos({ inputTokens: 0, outputTokens: 0 }, 1_000_000, 1_000_000);
    expect(nanos).toBe(0n);
  });

  it('2x multiplier → nanos 翻倍', () => {
    const nanos = computeCreditNanos(
      { inputTokens: 3, outputTokens: 0 },
      2_000_000, // 2x
      1_000_000,
    );
    // 3 tokens * 2 / 1M tpc = 6e-6 Credit = 6000 nanos
    expect(nanos).toBe(6000n);
  });

  it('非法 tokensPerCredit 抛 RangeError', () => {
    expect(() => computeCreditNanos({ inputTokens: 1, outputTokens: 0 }, 1_000_000, 0)).toThrow(
      RangeError,
    );
    expect(() => computeCreditNanos({ inputTokens: 1, outputTokens: 0 }, 1_000_000, -1)).toThrow(
      RangeError,
    );
  });

  it('负 multiplier 抛 RangeError', () => {
    expect(() => computeCreditNanos({ inputTokens: 1, outputTokens: 0 }, -1, 1_000_000)).toThrow(
      RangeError,
    );
  });
});

describe('credits/单位换算', () => {
  it('creditsToNanos 与 nanosToCredits 互逆（整数 Credits）', () => {
    for (const c of [0, 1, 100, 1000, 12345]) {
      const nanos = creditsToNanos(c);
      expect(nanosToCredits(nanos)).toBe(c);
    }
  });

  it('creditsToNanos 与 nanosToCredits 互逆（小数 Credits）', () => {
    for (const c of [0.5, 1.5, 12.25]) {
      const nanos = creditsToNanos(c);
      expect(nanosToCredits(nanos)).toBeCloseTo(c, 10);
    }
  });

  it('creditsToNanos: 1 Credit = 1_000_000_000 nanos, 0.5 = 500_000_000', () => {
    expect(creditsToNanos(1)).toBe(1_000_000_000n);
    expect(creditsToNanos(0.5)).toBe(500_000_000n);
    expect(creditsToNanos(100)).toBe(100_000_000_000n);
  });
});

describe('credits/validateNanosRange', () => {
  it('MAX_SIGNED_64BIT 通过', () => {
    expect(() => validateNanosRange(MAX_SIGNED_64BIT)).not.toThrow();
  });

  it('0 通过', () => {
    expect(() => validateNanosRange(0n)).not.toThrow();
  });

  it('超出 signed 64-bit 上界抛 RangeError', () => {
    expect(() => validateNanosRange(MAX_SIGNED_64BIT + 1n)).toThrow(RangeError);
  });

  it('低于 signed 64-bit 下界抛 RangeError', () => {
    expect(() => validateNanosRange(-9223372036854775808n - 1n)).toThrow(RangeError);
  });
});

describe('credits/monthWindow', () => {
  it('UTC：返回当前自然月起止（含下月独占 end）', () => {
    // 2026-08-15 12:00 UTC
    const at = new Date(Date.UTC(2026, 7, 15, 12, 0, 0));
    const { start, end } = monthWindow('UTC', at);
    // start = 2026-08-01 00:00 UTC
    expect(start.getTime()).toBe(Date.UTC(2026, 7, 1));
    // end = 2026-09-01 00:00 UTC（独占）
    expect(end.getTime()).toBe(Date.UTC(2026, 8, 1));
  });

  it('UTC：1 月窗口为 [2026-01-01, 2026-02-01)', () => {
    const at = new Date(Date.UTC(2026, 0, 15, 3, 0, 0)); // 2026-01-15
    const { start, end } = monthWindow('UTC', at);
    expect(start.getTime()).toBe(Date.UTC(2026, 0, 1));
    expect(end.getTime()).toBe(Date.UTC(2026, 1, 1));
  });

  it('UTC：12 月窗口跨年到次年 1 月', () => {
    const at = new Date(Date.UTC(2026, 11, 15, 3, 0, 0)); // 2026-12-15
    const { start, end } = monthWindow('UTC', at);
    expect(start.getTime()).toBe(Date.UTC(2026, 11, 1));
    expect(end.getTime()).toBe(Date.UTC(2027, 0, 1));
  });

  it('Asia/Shanghai（UTC+8）：月初在 UTC 中是上月最后一天 16:00', () => {
    // 2026-08-15 12:00 UTC = 2026-08-15 20:00 Shanghai
    const at = new Date(Date.UTC(2026, 7, 15, 12, 0, 0));
    const { start, end } = monthWindow('Asia/Shanghai', at);
    // Shanghai 2026-08-01 00:00 = UTC 2026-07-31 16:00
    expect(start.getTime()).toBe(Date.UTC(2026, 6, 31, 16, 0, 0));
    // Shanghai 2026-09-01 00:00 = UTC 2026-08-31 16:00
    expect(end.getTime()).toBe(Date.UTC(2026, 7, 31, 16, 0, 0));
  });

  it('Asia/Shanghai：在 UTC 月初临界点保持该时区月份语义', () => {
    // 2026-09-01 00:30 UTC = 2026-09-01 08:30 Shanghai，仍是 9 月
    const at = new Date(Date.UTC(2026, 8, 1, 0, 30, 0));
    const { start, end } = monthWindow('Asia/Shanghai', at);
    expect(start.getTime()).toBe(Date.UTC(2026, 7, 31, 16, 0, 0));
    expect(end.getTime()).toBe(Date.UTC(2026, 8, 30, 16, 0, 0)); // 10-01 00:00 Shanghai
  });
});

describe('credits/monthKey', () => {
  it('UTC：返回 YYYY-MM 格式', () => {
    const at = new Date(Date.UTC(2026, 7, 15, 23, 59, 59));
    expect(monthKey('UTC', at)).toBe('2026-08');
  });

  it('UTC：1 月返回 "2026-01"', () => {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(monthKey('UTC', at)).toBe('2026-01');
  });

  it('Asia/Shanghai：月末 UTC 23:30 在 Shanghai 已跨入下月', () => {
    // 2026-08-31 23:30 UTC = 2026-09-01 07:30 Shanghai
    const at = new Date(Date.UTC(2026, 7, 31, 23, 30, 0));
    expect(monthKey('Asia/Shanghai', at)).toBe('2026-09');
    // 同一时刻 UTC 仍是 8 月
    expect(monthKey('UTC', at)).toBe('2026-08');
  });
});

describe('credits/checkQuota', () => {
  it('used < limit：exceeded=false，remaining=limit-used', () => {
    const status = checkQuota(30n, 100n);
    expect(status.exceeded).toBe(false);
    expect(status.remainingNanos).toBe(70n);
    expect(status.usedNanos).toBe(30n);
    expect(status.limitNanos).toBe(100n);
  });

  it('used == limit：exceeded=true（admission control 临界即拒），remaining=0', () => {
    const status = checkQuota(100n, 100n);
    expect(status.exceeded).toBe(true);
    expect(status.remainingNanos).toBe(0n);
  });

  it('used > limit：exceeded=true，remaining=0', () => {
    const status = checkQuota(150n, 100n);
    expect(status.exceeded).toBe(true);
    expect(status.remainingNanos).toBe(0n);
  });

  it('used=0：exceeded=false，remaining=limit', () => {
    const status = checkQuota(0n, 100n);
    expect(status.exceeded).toBe(false);
    expect(status.remainingNanos).toBe(100n);
  });

  it('limit=0：used>=0 即超限（used=0 也算超限）', () => {
    // used=0 >= limit=0 → exceeded=true
    const status = checkQuota(0n, 0n);
    expect(status.exceeded).toBe(true);
    expect(status.remainingNanos).toBe(0n);
  });

  it('负值入参抛 RangeError', () => {
    expect(() => checkQuota(-1n, 100n)).toThrow(RangeError);
    expect(() => checkQuota(0n, -1n)).toThrow(RangeError);
  });
});
