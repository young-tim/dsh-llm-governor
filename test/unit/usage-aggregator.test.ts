/**
 * UsageAggregator 单元测试：覆盖 record、queryByUser、queryByModel、queryByRouting、
 * listEvents、幂等语义，以及 P95/平均延迟/成功率/Fallback 率/模型分布等聚合逻辑。
 */
import { describe, it, expect } from 'vitest';
import { UsageAggregator } from '../../src/usage/aggregator.js';
import type { UsageEvent } from '../../src/usage/types.js';

/** 构造一个最小 UsageEvent，便于在测试中复用。 */
function sampleEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'ev-1',
    requestId: 'req-1',
    sessionId: 'session-1',
    turn: 1,
    step: 1,
    userId: 'user-1',
    provider: 'fake-provider',
    model: 'model-a',
    routingMode: 'auto',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    creditNanos: 1_000_000n,
    success: true,
    latencyMs: 200,
    fallbackIndex: 0,
    attemptOrigin: 'provider',
    usageMissing: false,
    createdAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('UsageAggregator/record 幂等', () => {
  it('重复插入相同 (requestId, fallbackIndex) 被忽略，不双计费', () => {
    const agg = new UsageAggregator();
    const event = sampleEvent();
    agg.record(event);
    // 再次写入相同键，但 creditNanos 不同；应被忽略
    agg.record(sampleEvent({ creditNanos: 9_999_999n }));
    const events = agg.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.creditNanos).toBe(1_000_000n);
  });

  it('相同 requestId 但不同 fallbackIndex 视为独立事件', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ fallbackIndex: 0 }));
    agg.record(sampleEvent({ fallbackIndex: 1, creditNanos: 2_000_000n }));
    const events = agg.listEvents();
    expect(events).toHaveLength(2);
  });
});

describe('UsageAggregator/queryByUser', () => {
  it('聚合该用户全部 attempt 的 Tokens、Credits、模型分布', () => {
    const agg = new UsageAggregator();
    agg.record(
      sampleEvent({
        requestId: 'r1',
        fallbackIndex: 0,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        creditNanos: 1_000_000n,
        success: true,
        latencyMs: 100,
      }),
    );
    agg.record(
      sampleEvent({
        requestId: 'r2',
        fallbackIndex: 0,
        model: 'model-b',
        inputTokens: 200,
        outputTokens: 80,
        creditNanos: 2_500_000n,
        success: false,
        latencyMs: 300,
        fallbackIndex: 1,
      }),
    );
    // 其他用户不计入
    agg.record(
      sampleEvent({
        requestId: 'r3',
        userId: 'other-user',
        inputTokens: 9999,
        creditNanos: 9_999_999n,
      }),
    );

    const stats = agg.queryByUser('user-1');
    expect(stats.attemptCount).toBe(2);
    expect(stats.requestCount).toBe(2);
    expect(stats.inputTokens).toBe(300);
    expect(stats.outputTokens).toBe(130);
    expect(stats.cacheReadTokens).toBe(10);
    expect(stats.cacheWriteTokens).toBe(5);
    // raw = input + output + cache_read + cache_write = 300+130+10+5 = 445
    expect(stats.totalRawTokens).toBe(445);
    expect(stats.totalCreditNanos).toBe(3_500_000n);
    expect(stats.avgCreditNanos).toBe(1_750_000);
    expect(stats.successCount).toBe(1);
    expect(stats.successRate).toBeCloseTo(0.5, 5);
    expect(stats.fallbackCount).toBe(1);
    expect(stats.fallbackRate).toBeCloseTo(0.5, 5);
    expect(stats.avgLatencyMs).toBe(200);
    // 模型分布：两个 attempt 跨 2 个模型
    expect(stats.modelDistribution).toEqual({
      'fake-provider/model-a': 1,
      'fake-provider/model-b': 1,
    });
  });

  it('reasoningTokens 是 outputTokens 子集，不重复计入 raw tokens', () => {
    const agg = new UsageAggregator();
    agg.record(
      sampleEvent({
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        creditNanos: 0n,
      }),
    );
    const stats = agg.queryByUser('user-1');
    expect(stats.reasoningTokens).toBe(5);
    // raw = 10 + 20 + 0 + 0 = 30；不应为 35
    expect(stats.totalRawTokens).toBe(30);
  });

  it('未记录任何事件时返回空统计', () => {
    const agg = new UsageAggregator();
    const stats = agg.queryByUser('nobody');
    expect(stats.requestCount).toBe(0);
    expect(stats.attemptCount).toBe(0);
    expect(stats.totalCreditNanos).toBe(0n);
    expect(stats.avgCreditNanos).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.fallbackRate).toBe(0);
    expect(stats.avgLatencyMs).toBe(0);
    expect(stats.p95LatencyMs).toBe(0);
    expect(stats.modelDistribution).toEqual({});
  });
});

describe('UsageAggregator/queryByModel', () => {
  it('聚合指定 provider+model 的 Requests、Tokens、Credits', () => {
    const agg = new UsageAggregator();
    agg.record(
      sampleEvent({
        requestId: 'r1',
        provider: 'fake-provider',
        model: 'model-a',
        inputTokens: 100,
        outputTokens: 50,
        creditNanos: 1_000_000n,
        success: true,
        latencyMs: 200,
        fallbackIndex: 0,
      }),
    );
    agg.record(
      sampleEvent({
        requestId: 'r1',
        fallbackIndex: 1,
        provider: 'fake-provider',
        model: 'model-a',
        inputTokens: 80,
        outputTokens: 40,
        creditNanos: 800_000n,
        success: true,
        latencyMs: 150,
      }),
    );
    // 其他模型不计入
    agg.record(
      sampleEvent({
        requestId: 'r2',
        provider: 'fake-provider',
        model: 'model-b',
        inputTokens: 9999,
        creditNanos: 9_999_999n,
      }),
    );
    // 其他 provider 不计入
    agg.record(
      sampleEvent({
        requestId: 'r3',
        provider: 'other-provider',
        model: 'model-a',
        inputTokens: 9999,
        creditNanos: 9_999_999n,
      }),
    );

    const stats = agg.queryByModel('fake-provider', 'model-a');
    expect(stats.attemptCount).toBe(2);
    // 同一 requestId 的两个 fallback attempt → 1 个逻辑请求
    expect(stats.requestCount).toBe(1);
    expect(stats.inputTokens).toBe(180);
    expect(stats.outputTokens).toBe(90);
    expect(stats.totalCreditNanos).toBe(1_800_000n);
    expect(stats.successCount).toBe(2);
    expect(stats.successRate).toBe(1);
    expect(stats.fallbackCount).toBe(1);
    expect(stats.fallbackRate).toBeCloseTo(0.5, 5);
    expect(stats.avgLatencyMs).toBe(175);
    expect(stats.modelDistribution).toEqual({ 'fake-provider/model-a': 2 });
  });

  it('未匹配到事件时返回空统计', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent());
    const stats = agg.queryByModel('fake-provider', 'no-such-model');
    expect(stats.attemptCount).toBe(0);
    expect(stats.totalCreditNanos).toBe(0n);
  });
});

describe('UsageAggregator/queryByRouting', () => {
  it('聚合指定 routing_mode 的请求量、平均 Credits、成功率', () => {
    const agg = new UsageAggregator();
    agg.record(
      sampleEvent({
        requestId: 'r1',
        routingMode: 'quality_first',
        creditNanos: 1_000_000n,
        success: true,
        latencyMs: 100,
        fallbackIndex: 0,
      }),
    );
    agg.record(
      sampleEvent({
        requestId: 'r2',
        routingMode: 'quality_first',
        creditNanos: 3_000_000n,
        success: false,
        latencyMs: 200,
        fallbackIndex: 1,
      }),
    );
    // 其他 routing_mode 不计入
    agg.record(
      sampleEvent({
        requestId: 'r3',
        routingMode: 'auto',
        creditNanos: 9_999_999n,
      }),
    );

    const stats = agg.queryByRouting('quality_first');
    expect(stats.attemptCount).toBe(2);
    expect(stats.requestCount).toBe(2);
    expect(stats.totalCreditNanos).toBe(4_000_000n);
    expect(stats.avgCreditNanos).toBe(2_000_000);
    expect(stats.successCount).toBe(1);
    expect(stats.successRate).toBeCloseTo(0.5, 5);
    expect(stats.fallbackCount).toBe(1);
    expect(stats.fallbackRate).toBeCloseTo(0.5, 5);
    expect(stats.avgLatencyMs).toBe(150);
  });

  it('未匹配到事件时返回空统计', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ routingMode: 'auto' }));
    const stats = agg.queryByRouting('credit_first');
    expect(stats.attemptCount).toBe(0);
  });
});

describe('UsageAggregator/listEvents', () => {
  it('无过滤时返回全部事件（按插入序）', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ id: 'e1', requestId: 'r1', fallbackIndex: 0 }));
    agg.record(sampleEvent({ id: 'e2', requestId: 'r2', fallbackIndex: 0 }));
    agg.record(sampleEvent({ id: 'e3', requestId: 'r3', fallbackIndex: 0 }));
    const events = agg.listEvents();
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('按 userId 过滤', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ id: 'e1', requestId: 'r1', userId: 'alice' }));
    agg.record(sampleEvent({ id: 'e2', requestId: 'r2', userId: 'bob' }));
    agg.record(sampleEvent({ id: 'e3', requestId: 'r3', userId: 'alice' }));
    const events = agg.listEvents({ userId: 'alice' });
    expect(events.map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('按 provider 过滤', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ id: 'e1', requestId: 'r1', provider: 'p-a' }));
    agg.record(sampleEvent({ id: 'e2', requestId: 'r2', provider: 'p-b' }));
    agg.record(sampleEvent({ id: 'e3', requestId: 'r3', provider: 'p-a' }));
    const events = agg.listEvents({ provider: 'p-a' });
    expect(events.map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('同时按 userId 和 provider 过滤（AND 语义）', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ id: 'e1', requestId: 'r1', userId: 'alice', provider: 'p-a' }));
    agg.record(sampleEvent({ id: 'e2', requestId: 'r2', userId: 'alice', provider: 'p-b' }));
    agg.record(sampleEvent({ id: 'e3', requestId: 'r3', userId: 'bob', provider: 'p-a' }));
    const events = agg.listEvents({ userId: 'alice', provider: 'p-a' });
    expect(events.map((e) => e.id)).toEqual(['e1']);
  });

  it('空过滤器对象等价于无过滤', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ id: 'e1', requestId: 'r1' }));
    agg.record(sampleEvent({ id: 'e2', requestId: 'r2' }));
    const events = agg.listEvents({});
    expect(events).toHaveLength(2);
  });
});

describe('UsageAggregator/P95 延迟', () => {
  it('单条事件 P95 等于该事件延迟', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ requestId: 'r1', latencyMs: 250 }));
    const stats = agg.queryByUser('user-1');
    expect(stats.p95LatencyMs).toBe(250);
  });

  it('20 条事件 P95 取第 19 大的延迟（nearest-rank）', () => {
    const agg = new UsageAggregator();
    // 20 个事件，延迟为 100..119
    for (let i = 0; i < 20; i++) {
      agg.record(
        sampleEvent({
          requestId: `r${i}`,
          fallbackIndex: 0,
          latencyMs: 100 + i,
        }),
      );
    }
    const stats = agg.queryByUser('user-1');
    // ceil(20 * 0.95) = 19，sorted[18] = 118（0-based）
    expect(stats.p95LatencyMs).toBe(118);
    // 平均 = (100+119)/2 = 109.5
    expect(stats.avgLatencyMs).toBeCloseTo(109.5, 5);
  });

  it('2 条事件 P95 取较高者', () => {
    const agg = new UsageAggregator();
    agg.record(sampleEvent({ requestId: 'r1', latencyMs: 100 }));
    agg.record(sampleEvent({ requestId: 'r2', latencyMs: 500 }));
    const stats = agg.queryByUser('user-1');
    // ceil(2*0.95)=2，sorted[1] = 500
    expect(stats.p95LatencyMs).toBe(500);
  });
});
