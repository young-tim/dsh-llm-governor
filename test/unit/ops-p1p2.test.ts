/**
 * 任务4 单元测试：GOV-CLASSIFIER-001 / GOV-USAGE-001 / GOV-OPS-002 / GOV-OPS-003。
 * 每个 GOV ID 至少一条正向与一条边界/失败测试（测试名含 GOV ID）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';
import {
  SQLiteClassifierCache,
  createSingleFlight,
  buildClassifierCacheKey,
  hmacInputHash,
  CLASSIFIER_CACHE_TTL_MS,
} from '../../src/classifier/sqlite-cache.js';
import { escapeCsvCell, exportWithLimits, toCsv, pseudonymizeUser, EXPORT_LIMITS } from '../../src/ops/export.js';
import { computeRoutingMetrics, buildSamplesFromRows } from '../../src/ops/metrics.js';
import type { AutoRequestSample } from '../../src/ops/metrics.js';
import { sealDecision } from '../../src/routing/decision.js';
import type { Classification } from '../../src/classifier/types.js';

/** 构造临时 repository。 */
function tempRepo(): { repo: GovernorRepository; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gov-p1p2-'));
  const db = new GovernorDatabase(join(dir, 'test.db'));
  const repo = new GovernorRepository(db);
  return { repo, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('GOV-CLASSIFIER-001 SQLite 分类缓存', () => {
  it('正向：命中缓存不产生新的 classifier 调用；缓存持久化可复用', () => {
    const { repo, dispose } = tempRepo();
    try {
      const cache = new SQLiteClassifierCache(repo);
      const key = cache.buildKey('{"messages":[]}', 1);
      const value: Classification = { taskType: 'coding', complexity: 'high', confidence: 0.95, source: 'llm' };
      expect(cache.get(key)).toBeUndefined();
      cache.set(key, value);
      expect(cache.get(key)).toEqual(value);
      // 新实例（模拟重启）复用同一持久化缓存
      const cache2 = new SQLiteClassifierCache(repo);
      expect(cache2.get(key)).toEqual(value);
    } finally {
      dispose();
    }
  });

  it('边界：revision / promptVersion / tenant 任一变化 → miss（键版本化合同）', () => {
    const { repo, dispose } = tempRepo();
    try {
      const cache = new SQLiteClassifierCache(repo);
      const key1 = buildClassifierCacheKey(hmacInputHash('input', 'k'), 'default', 'v1', 1, 'default');
      cache.set(key1, { taskType: 'general', complexity: 'low', confidence: 0.9, source: 'llm' });
      // revision 变化
      const key2 = buildClassifierCacheKey(hmacInputHash('input', 'k'), 'default', 'v1', 2, 'default');
      expect(cache.get(key2)).toBeUndefined();
      // promptVersion 变化
      const key3 = buildClassifierCacheKey(hmacInputHash('input', 'k'), 'default', 'v2', 1, 'default');
      expect(cache.get(key3)).toBeUndefined();
      // tenant 变化
      const key4 = buildClassifierCacheKey(hmacInputHash('input', 'k'), 'default', 'v1', 1, 'other');
      expect(cache.get(key4)).toBeUndefined();
      // 原键仍命中
      expect(cache.get(key1)).toBeDefined();
    } finally {
      dispose();
    }
  });

  it('边界：TTL 过期条目视为 miss（默认 7 天）', () => {
    const { repo, dispose } = tempRepo();
    try {
      const cache = new SQLiteClassifierCache(repo, { ttlMs: 10 });
      const key = cache.buildKey('input', 1);
      cache.set(key, { taskType: 'general', complexity: 'low', confidence: 0.9, source: 'llm' });
      expect(cache.get(key)).toBeDefined();
      // 等待 TTL 过期
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(cache.get(key)).toBeUndefined();
          resolve();
          dispose();
        }, 30);
      });
    } catch {
      dispose();
      throw new Error('unreachable');
    }
  });

  it('正向：single-flight 并发同键只触发一次底层调用', async () => {
    const sf = createSingleFlight();
    let calls = 0;
    const fn = async (): Promise<number> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    };
    const [a, b, c] = await Promise.all([sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)]);
    expect(calls).toBe(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
    // 完成后再次执行产生新调用
    await sf.run('k', fn);
    expect(calls).toBe(2);
  });

  it('边界：默认 TTL 为 7 天（CLASSIFIER_CACHE_TTL_MS 常量）', () => {
    expect(CLASSIFIER_CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('GOV-USAGE-001 用量种类与统计分母', () => {
  it('正向：usageKind=conversation/classifier 落库并按种类过滤；双分母统计', () => {
    const { repo, dispose } = tempRepo();
    try {
      repo.insertUsageEvent({
        requestId: 'conv-1', fallbackIndex: 0, sessionId: 's1', turn: 1, step: 1,
        userId: 'u1', provider: 'p', model: 'm', routingMode: 'auto',
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
        creditNanos: 100n, success: true, latencyMs: 10,
        attemptOrigin: 'provider', usageMissing: false, createdAt: '2026-08-21T00:00:00Z',
      });
      repo.insertUsageEvent({
        requestId: 'conv-1', fallbackIndex: 1, sessionId: 's1', turn: 1, step: 1,
        userId: 'u1', provider: 'p', model: 'm2', routingMode: 'auto',
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
        creditNanos: 100n, success: true, latencyMs: 10,
        attemptOrigin: 'provider', usageMissing: false, createdAt: '2026-08-21T00:00:01Z',
      });
      repo.insertUsageEvent({
        requestId: 'cls-1', fallbackIndex: 0, sessionId: 's1', usageKind: 'classifier',
        parentRequestId: 'conv-1', turn: 0, step: 0,
        userId: 'u1', provider: 'p', model: 'cls', routingMode: 'auto',
        inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
        creditNanos: 20n, success: true, latencyMs: 5,
        attemptOrigin: 'provider', usageMissing: false, createdAt: '2026-08-21T00:00:02Z',
      });
      // 按种类过滤
      const conv = repo.queryUsage({ usageKind: 'conversation' });
      const cls = repo.queryUsage({ usageKind: 'classifier' });
      expect(conv).toHaveLength(2);
      expect(cls).toHaveLength(1);
      expect(cls[0]!.usageKind).toBe('classifier');
      expect(cls[0]!.parentRequestId).toBe('conv-1');
      // 双分母：Requests 以 requestId 去重（2：conv-1/cls-1），Attempts 按行数（3）
      expect(repo.countUsageRequests()).toEqual({ requests: 2, attempts: 3 });
      // conversation 分母：1 request / 2 attempts
      expect(repo.countUsageRequests({ usageKind: 'conversation' })).toEqual({ requests: 1, attempts: 2 });
    } finally {
      dispose();
    }
  });

  it('边界：usage_missing=true 的 Provider 未报告 usage 与真实 0 用量可区分', () => {
    const { repo, dispose } = tempRepo();
    try {
      repo.insertUsageEvent({
        requestId: 'r1', fallbackIndex: 0, sessionId: 's', turn: 1, step: 1,
        userId: 'u', provider: 'p', model: 'm', routingMode: 'manual',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        creditNanos: 0n, success: true, latencyMs: 5,
        attemptOrigin: 'provider', usageMissing: true, createdAt: '2026-08-21T00:00:00Z',
      });
      const rows = repo.queryUsage({});
      expect(rows[0]!.usageMissing).toBe(true);
      // usage_missing 比例计入数据质量（GOV-USAGE-001 AC 4 的数据基础）
    } finally {
      dispose();
    }
  });
});

describe('GOV-OPS-002 导出与 CSV 注入防护', () => {
  it('正向：CSV 导出包含表头与转义后的单元格', () => {
    const rows = [
      { user: '=SUM(A1:A9)', route: '+cmd', note: '-1+1', extra: '@ref', plain: 'ok' },
      { user: 'alice', route: 'p:m', note: 'x', extra: 'y', plain: '2' },
    ];
    const csv = toCsv(rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('user,route,note,extra,plain');
    expect(lines[1]).toBe("'=SUM(A1:A9),'+cmd,'-1+1,'@ref,ok");
    expect(lines[2]).toBe('alice,p:m,x,y,2');
  });

  it('边界：escapeCsvCell 只转义 = + - @ 开头', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+x')).toBe("'+x");
    expect(escapeCsvCell('-y')).toBe("'-y");
    expect(escapeCsvCell('@z')).toBe("'@z");
    expect(escapeCsvCell('normal')).toBe('normal');
    expect(escapeCsvCell('a=b')).toBe('a=b');
  });

  it('边界：超过 10,000 行截断（truncatedBy=rows）', () => {
    const rows = Array.from({ length: EXPORT_LIMITS.maxRows + 500 }, (_, i) => ({ i }));
    const result = exportWithLimits(rows, (rs) => toCsv(rs as never));
    expect(result.rowCount).toBe(EXPORT_LIMITS.maxRows);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('rows');
  });

  it('正向：user 以稳定假名展示（不含原始 ID）', () => {
    const p1 = pseudonymizeUser('alice@example.com');
    expect(p1).toMatch(/^user-[0-9a-f]{8}$/);
    expect(p1).toBe(pseudonymizeUser('alice@example.com'));
    expect(p1).not.toBe(pseudonymizeUser('bob@example.com'));
  });
});

describe('GOV-OPS-003 路由效果指标', () => {
  /** 构造一个 Auto 样本：Auto 选便宜模型，QF 会选贵的。 */
  function sample(overrides: Partial<AutoRequestSample> = {}): AutoRequestSample {
    return {
      requestId: 'req-x',
      finalRoute: 'p:cheap',
      attempts: [
        {
          fallbackIndex: 0,
          routeId: 'p:cheap',
          totalTokens: 1000,
          creditNanos: 500_000n, // 0.5x multiplier × 1000 tokens
          usageMissing: false,
          completed: true,
        },
      ],
      classifierCreditNanos: 10_000n,
      qualityFirstRoute: { routeId: 'p:best', multiplierPpm: 2_000_000, quality: 95 },
      autoRoute: { routeId: 'p:cheap', multiplierPpm: 500_000, quality: 90 },
      ...overrides,
    };
  }

  it('正向：有效样本充足时计算节省/保留/成功率', () => {
    const samples = Array.from({ length: METRICS_MIN }, () => sample());
    const m = computeRoutingMetrics(samples, 1_000_000);
    expect(m.requests).toBe(METRICS_MIN);
    expect(m.attempts).toBe(METRICS_MIN);
    expect(m.requestSuccessRate).toBe(1);
    // 反事实 = 1000 tokens × 2x = 实际的 4 倍（0.5x），节省 ≈ 0.75
    expect(m.estimatedCreditSaving).toBeGreaterThan(0.7);
    expect(m.estimatedCreditSaving).toBeLessThan(0.8);
    // 配置保留 = 90/95
    expect(m.configuredQualityRetention).toBeCloseTo(90 / 95, 5);
    expect(m.insufficientSample).toBe(false);
  });

  it('边界：有效样本少于 100 → insufficientSample，隐藏百分比', () => {
    const m = computeRoutingMetrics(Array.from({ length: 99 }, () => sample()), 1_000_000);
    expect(m.insufficientSample).toBe(true);
    expect(m.estimatedCreditSaving).toBeUndefined();
    expect(m.configuredQualityRetention).toBeUndefined();
  });

  it('边界：usage_missing > 5% → 不足以判断', () => {
    const samples = Array.from({ length: METRICS_MIN }, (_unused, i) =>
      sample({
        requestId: `req-${i}`,
        attempts: [
          {
            fallbackIndex: 0,
            routeId: 'p:cheap',
            totalTokens: 100,
            creditNanos: 1n,
            usageMissing: i % 10 === 0, // 10% missing
            completed: true,
          },
        ],
      }),
    );
    const m = computeRoutingMetrics(samples, 1_000_000);
    expect(m.usageMissingRatio).toBeGreaterThan(0.05);
    expect(m.insufficientSample).toBe(true);
  });

  it('正向：buildSamplesFromRows 从持久化行聚合样本（QF 反事实取最高 quality）', () => {
    const { repo, dispose } = tempRepo();
    try {
      const decision = sealDecision({
        requestId: 'req-1', turn: 1, step: 1, fallbackIndex: 0, causes: ['initial'],
        changedFields: [], selectionMode: 'auto', effectiveStrategy: 'credit_first',
        candidates: [
          { routeId: 'p:cheap', quality: 70, multiplierPpm: 500_000 },
          { routeId: 'p:best', quality: 95, multiplierPpm: 2_000_000 },
        ],
        excluded: [], outcome: 'selected', selectedRoute: 'p:cheap', configRevision: 1,
      });
      repo.insertSealedDecision(decision, { sessionId: 's1' });
      repo.markDecisionCommitted(decision.decisionId, decision.decisionHash);
      repo.insertUsageEvent({
        requestId: 'req-1', fallbackIndex: 0, sessionId: 's1', turn: 1, step: 1,
        userId: 'u', provider: 'p', model: 'cheap', routingMode: 'auto',
        inputTokens: 600, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0,
        creditNanos: 500_000n, success: true, latencyMs: 10,
        attemptOrigin: 'provider', usageMissing: false, createdAt: '2026-08-21T00:00:00Z',
      });
      const directory = new Map([
        ['p:cheap', { multiplierPpm: 500_000, quality: 70 }],
        ['p:best', { multiplierPpm: 2_000_000, quality: 95 }],
      ]);
      const decisions = repo.getDecisions('req-1');
      const usages = repo.queryUsage({});
      const samples = buildSamplesFromRows(decisions, usages, directory);
      expect(samples).toHaveLength(1);
      expect(samples[0]!.finalRoute).toBe('p:cheap');
      expect(samples[0]!.qualityFirstRoute.routeId).toBe('p:best');
      expect(samples[0]!.attempts[0]!.totalTokens).toBe(1000);
    } finally {
      dispose();
    }
  });
});

/** 指标测试的有效样本数（≥ METRICS_THRESHOLDS.minSamples）。 */
const METRICS_MIN = 100;
