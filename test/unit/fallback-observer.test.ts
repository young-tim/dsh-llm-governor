/**
 * Fallback + Observer 单元测试：覆盖 isRetryable、FallbackState、observeStream。
 */
import { describe, it, expect } from 'vitest';
import { isRetryable, FallbackState } from '../../src/fallback/mod.js';
import { observeStream } from '../../src/usage/observer.js';
import type { StreamChunkLike } from '../../src/usage/observer.js';
import type { UsageEvent } from '../../src/usage/types.js';

// ===== isRetryable =====

describe('isRetryable', () => {
  it('RATE_LIMIT 可重试', () => {
    expect(isRetryable({ code: 'RATE_LIMIT', status: 429, message: 'rate limited' })).toBe(true);
  });

  it('TIMEOUT 可重试', () => {
    expect(isRetryable({ code: 'TIMEOUT', message: 'timed out' })).toBe(true);
  });

  it('SERVER_ERROR 可重试', () => {
    expect(isRetryable({ code: 'SERVER_ERROR', status: 503, message: '5xx' })).toBe(true);
  });

  it('SERVICE_UNAVAILABLE 可重试', () => {
    expect(isRetryable({ code: 'SERVICE_UNAVAILABLE', message: 'unavailable' })).toBe(true);
  });

  it('PROVIDER_UNAVAILABLE 可重试', () => {
    expect(isRetryable({ code: 'PROVIDER_UNAVAILABLE', message: 'unavailable' })).toBe(true);
  });

  it('EMPTY_RESPONSE 可重试', () => {
    expect(isRetryable({ code: 'EMPTY_RESPONSE', message: 'empty' })).toBe(true);
  });

  it('TRANSPORT_UNAVAILABLE 可重试', () => {
    expect(isRetryable({ code: 'TRANSPORT_UNAVAILABLE', message: 'transport' })).toBe(true);
  });

  it('429 状态码可重试（即使 code 未知）', () => {
    expect(isRetryable({ code: 'UNKNOWN', status: 429, message: '429' })).toBe(true);
  });

  it('5xx 状态码可重试（即使 code 未知）', () => {
    expect(isRetryable({ code: 'UNKNOWN', status: 500, message: '500' })).toBe(true);
    expect(isRetryable({ code: 'UNKNOWN', status: 599, message: '599' })).toBe(true);
  });

  it('401 不可重试', () => {
    expect(isRetryable({ code: 'AUTH', status: 401, message: 'unauthorized' })).toBe(false);
  });

  it('403 不可重试', () => {
    expect(isRetryable({ code: 'FORBIDDEN', status: 403, message: 'forbidden' })).toBe(false);
  });

  it('未知 code 且无状态码不可重试', () => {
    expect(isRetryable({ code: 'UNKNOWN', message: 'unknown' })).toBe(false);
  });

  it('4xx（非 429、非 401/403）不可重试', () => {
    expect(isRetryable({ code: 'BAD_REQUEST', status: 400, message: 'bad' })).toBe(false);
    expect(isRetryable({ code: 'NOT_FOUND', status: 404, message: 'not found' })).toBe(false);
  });

  it('无状态码的 RATE_LIMIT 可重试', () => {
    expect(isRetryable({ code: 'RATE_LIMIT', message: 'rate limited' })).toBe(true);
  });
});

// ===== FallbackState =====

describe('FallbackState', () => {
  it('初始状态 attemptCount=0，canRetry=true', () => {
    const fs = new FallbackState(2);
    expect(fs.attemptCount).toBe(0);
    expect(fs.canRetry()).toBe(true);
    expect(fs.excludedRoutes.size).toBe(0);
    expect(fs.partialOutputDelivered).toBe(false);
  });

  it('recordAttempt 递增 attemptCount', () => {
    const fs = new FallbackState(3);
    fs.recordAttempt();
    expect(fs.attemptCount).toBe(1);
    fs.recordAttempt();
    expect(fs.attemptCount).toBe(2);
  });

  it('canRetry 在达到 maxAttempts 后返回 false', () => {
    const fs = new FallbackState(2);
    fs.recordAttempt();
    expect(fs.canRetry()).toBe(true);
    fs.recordAttempt();
    expect(fs.canRetry()).toBe(false);
  });

  it('excludeRoute 添加到排除集', () => {
    const fs = new FallbackState(2);
    fs.excludeRoute('provider:model-a');
    fs.excludeRoute('provider:model-b');
    expect(fs.excludedRoutes.size).toBe(2);
    expect(fs.excludedRoutes.has('provider:model-a')).toBe(true);
    expect(fs.excludedRoutes.has('provider:model-b')).toBe(true);
  });

  it('excludeRoute 幂等（重复添加同一路由）', () => {
    const fs = new FallbackState(2);
    fs.excludeRoute('provider:model-a');
    fs.excludeRoute('provider:model-a');
    expect(fs.excludedRoutes.size).toBe(1);
  });

  it('markPartialOutput 标记部分输出已交付', () => {
    const fs = new FallbackState(2);
    expect(fs.partialOutputDelivered).toBe(false);
    fs.markPartialOutput();
    expect(fs.partialOutputDelivered).toBe(true);
  });

  it('shouldRetry 对可重试错误返回 true（默认 afterPartialOutput=false）', () => {
    const fs = new FallbackState(2);
    fs.recordAttempt(); // count=1
    expect(fs.shouldRetry({ code: 'RATE_LIMIT', status: 429, message: '429' })).toBe(true);
  });

  it('shouldRetry 对不可重试错误返回 false', () => {
    const fs = new FallbackState(2);
    fs.recordAttempt();
    expect(fs.shouldRetry({ code: 'AUTH', status: 401, message: '401' })).toBe(false);
  });

  it('shouldRetry 达到 maxAttempts 后返回 false', () => {
    const fs = new FallbackState(1);
    fs.recordAttempt(); // count=1, maxAttempts=1 → canRetry=false
    expect(fs.shouldRetry({ code: 'RATE_LIMIT', status: 429, message: '429' })).toBe(false);
  });

  it('shouldRetry 部分输出后 + afterPartialOutput=false → false', () => {
    const fs = new FallbackState(2, false);
    fs.recordAttempt();
    fs.markPartialOutput();
    expect(fs.shouldRetry({ code: 'RATE_LIMIT', status: 429, message: '429' })).toBe(false);
  });

  it('shouldRetry 部分输出后 + afterPartialOutput=true → true', () => {
    const fs = new FallbackState(2, true);
    fs.recordAttempt();
    fs.markPartialOutput();
    expect(fs.shouldRetry({ code: 'RATE_LIMIT', status: 429, message: '429' })).toBe(true);
  });

  it('shouldRetry 未标记部分输出 + afterPartialOutput=true → true', () => {
    const fs = new FallbackState(2, true);
    fs.recordAttempt();
    expect(fs.shouldRetry({ code: 'SERVER_ERROR', status: 503, message: '5xx' })).toBe(true);
  });

  it('shouldRetry 在部分输出后、afterPartialOutput=false，但不可重试错误 → false', () => {
    const fs = new FallbackState(2, false);
    fs.recordAttempt();
    fs.markPartialOutput();
    // 401 不可重试，直接 false（不检查 partialOutput）
    expect(fs.shouldRetry({ code: 'AUTH', status: 401, message: '401' })).toBe(false);
  });
});

// ===== observeStream =====

/** 模拟 chunk 流。 */
async function* chunks(items: StreamChunkLike[]): AsyncIterable<StreamChunkLike> {
  for (const c of items) {
    yield c;
  }
}

/** 模拟抛错的流。 */
async function* throwingStream(err: Error): AsyncIterable<StreamChunkLike> {
  throw err;
  yield { type: 'never' }; // unreachable
}

/** 基础观察选项。 */
function baseOptions() {
  return {
    provider: 'fake-provider',
    model: 'model-a',
    sessionId: 'session-1',
    turn: 1,
    step: 1,
    requestId: 'req-1',
    fallbackIndex: 0,
    userId: 'user-1',
    routingMode: 'manual' as const,
  };
}

describe('observeStream', () => {
  it('成功流：透传所有 chunk，记录 usage + finish=stop', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    const stream = observeStream(baseOptions(), inner, (e) => events.push(e));
    const received: StreamChunkLike[] = [];
    for await (const c of stream) {
      received.push(c);
    }
    // 透传所有 chunk
    expect(received).toHaveLength(4);
    // 记录了 1 个事件
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.inputTokens).toBe(10);
    expect(ev.outputTokens).toBe(5);
    expect(ev.success).toBe(true);
    expect(ev.finishKind).toBe('stop');
    expect(ev.usageMissing).toBe(false);
    expect(ev.userId).toBe('user-1');
    expect(ev.provider).toBe('fake-provider');
    expect(ev.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('tool-calls finish 也视为成功', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([{ type: 'finish', reason: { kind: 'tool-calls' } }]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.success).toBe(true);
    expect(events[0]!.finishKind).toBe('tool-calls');
  });

  it('error finish 视为失败', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([
      {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429 } },
      },
    ]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.finishKind).toBe('error');
    expect(events[0]!.errorCode).toBe('RATE_LIMIT');
    expect(events[0]!.httpStatus).toBe(429);
  });

  it('inner 抛错时记录 errorCode 并重新抛出', async () => {
    const events: UsageEvent[] = [];
    const err = new Error('stream broke');
    err.name = 'StreamError';
    const stream = observeStream(baseOptions(), throwingStream(err), (e) => events.push(e));
    await expect(async () => {
      for await (const _ of stream) {
        void _;
      }
    }).rejects.toThrow('stream broke');
    // 即使抛错，finally 也记录了事件
    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.errorCode).toBe('StreamError');
  });

  it('inner 抛出非 Error 值时也记录事件并重新抛出', async () => {
    const events: UsageEvent[] = [];
    const stream = observeStream(
      baseOptions(),
      (async function* () {
        throw 'string error';
        yield undefined as never;
      })(),
      (e) => events.push(e),
    );
    await expect(async () => {
      for await (const _ of stream) {
        void _;
      }
    }).rejects.toBe('string error');
    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
  });

  it('无 usage chunk 时 usageMissing=true', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([{ type: 'finish', reason: { kind: 'stop' } }]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.usageMissing).toBe(true);
    expect(events[0]!.inputTokens).toBe(0);
    expect(events[0]!.outputTokens).toBe(0);
  });

  it('多份 usage chunk 取最后一份', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.inputTokens).toBe(20);
    expect(events[0]!.outputTokens).toBe(10);
  });

  it('cache_read + cache_write 计入', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.cacheReadTokens).toBe(3);
    expect(events[0]!.cacheWriteTokens).toBe(2);
  });

  it('reasoningTokens 计入', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.reasoningTokens).toBe(3);
  });

  it('无 finish chunk 时 success=false', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([{ type: 'text-delta', text: 'partial' }]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.finishKind).toBeUndefined();
  });

  it('提前 break（消费者提前终止）也记录事件', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    const stream = observeStream(baseOptions(), inner, (e) => events.push(e));
    for await (const _ of stream) {
      void _;
      break; // 提前终止
    }
    // 即使提前 break，finally 也记录了事件
    expect(events).toHaveLength(1);
  });

  it('空流也记录事件', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.usageMissing).toBe(true);
  });

  it('finish 有 failure 但无 status 时只记录 errorCode', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([
      {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'SOME_ERROR' } },
      },
    ]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.errorCode).toBe('SOME_ERROR');
    expect(events[0]!.httpStatus).toBeUndefined();
  });

  it('latencyMs 为非负数', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([{ type: 'finish', reason: { kind: 'stop' } }]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('事件 id 为合法 UUID', async () => {
    const events: UsageEvent[] = [];
    const inner = chunks([{ type: 'finish', reason: { kind: 'stop' } }]);
    for await (const _ of observeStream(baseOptions(), inner, (e) => events.push(e))) {
      void _;
    }
    expect(events[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
