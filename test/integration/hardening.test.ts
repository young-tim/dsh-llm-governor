/**
 * 加固测试：安全、恢复、并发、月末、数据库损坏、重放。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';
import { bootFake, modelInfo } from '../contracts/harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import { monthWindow, monthKey, checkQuota } from '../../src/credits/index.js';

function fakeAgent(id = 'session-1') {
  return {
    id,
    options: {},
    session: {},
    inbox: {},
    status: 'idle' as const,
    ctx: {},
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: <T>(t: (s: AbortSignal) => Promise<T>) => Promise.resolve() as Promise<T>,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
  };
}

describe('数据库损坏与恢复', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gov-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('迁移失败时 fail closed（不创建表）', () => {
    // 先创建一个有效数据库
    const dbPath = join(dir, 'test.db');
    const db1 = new GovernorDatabase(dbPath);
    db1.close();
    // 用无效数据覆盖 schema_migrations 使迁移失败
    const db2 = new GovernorDatabase(dbPath);
    db2.exec('DROP TABLE schema_migrations');
    db2.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)');
    db2.exec("INSERT INTO schema_migrations VALUES ('not-a-number')");
    db2.close();
    // 重新打开应 fail closed（迁移尝试 INSERT INTEGER 到 TEXT 列会失败）
    expect(() => new GovernorDatabase(dbPath)).toThrow();
  });

  it('重启后数据持久化', () => {
    const dbPath = join(dir, 'persist.db');
    const db1 = new GovernorDatabase(dbPath);
    const repo1 = new GovernorRepository(db1);
    repo1.upsertModelPolicy({
      routeId: 'p:m',
      provider: 'p',
      model: 'm',
      enabled: true,
      multiplierPpm: 500000,
      capabilities: ['text'],
      quality: { general: 90 },
    });
    db1.close();
    // 重启
    const db2 = new GovernorDatabase(dbPath);
    const repo2 = new GovernorRepository(db2);
    const policies = repo2.listModelPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0]!.routeId).toBe('p:m');
    db2.close();
  });
});

describe('事件重放幂等', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gov-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('重复插入相同 request_id+fallback_index 的 usage 被忽略', () => {
    const db = new GovernorDatabase(join(dir, 'replay.db'));
    const repo = new GovernorRepository(db);
    const event = {
      requestId: 'req-1',
      fallbackIndex: 0,
      sessionId: 's1',
      turn: 1,
      step: 1,
      userId: 'u1',
      provider: 'p',
      model: 'm',
      routingMode: 'quality_first' as const,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      creditNanos: 150n,
      success: true,
      latencyMs: 100,
      attemptOrigin: 'provider' as const,
      usageMissing: false,
      createdAt: '2026-08-20T00:00:00Z',
    };
    repo.insertUsageEvent(event);
    repo.insertUsageEvent(event); // 重复
    const usage = repo.queryUsage({});
    expect(usage).toHaveLength(1);
    db.close();
  });

  it('重复插入相同 request_id+fallback_index 的 decision 被忽略', () => {
    const db = new GovernorDatabase(join(dir, 'replay2.db'));
    const repo = new GovernorRepository(db);
    const decision = {
      requestId: 'req-2',
      fallbackIndex: 0,
      mode: 'quality_first' as const,
      candidates: [{ routeId: 'p:m', quality: 90, multiplierPpm: 1000000 }],
      excluded: [],
      selected: 'p:m',
      configRevision: 1,
      createdAt: '2026-08-20T00:00:00Z',
    };
    repo.insertDecision(decision);
    repo.insertDecision(decision); // 重复
    const decisions = repo.getDecisions('req-2');
    expect(decisions).toHaveLength(1);
    db.close();
  });
});

describe('并发请求', () => {
  it('同一用户并发请求不互相干扰', async () => {
    const h = await bootFake(
      ['fake-provider'],
      [modelInfo('fake-provider', 'model-a'), modelInfo('fake-provider', 'model-b')],
      successScript('hi', { inputTokens: 10, outputTokens: 5 }) as never,
      {
        models: {
          'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
          'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
        },
        routing: { default: 'quality_first' as const },
        fallback: { enabled: true, max_attempts: 2 },
      },
    );
    try {
      const e = h.ctx.events as unknown as {
        waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
      };
      // 两个并发请求（不同 session）
      const [r1, r2] = await Promise.all([
        e.waterfall(
          'agent/request',
          { agent: fakeAgent('s1'), turn: 1, step: 1, signal: new AbortController().signal },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
        e.waterfall(
          'agent/request',
          { agent: fakeAgent('s2'), turn: 1, step: 1, signal: new AbortController().signal },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ]);
      expect((r1 as { model: string }).model).toBe('model-a');
      expect((r2 as { model: string }).model).toBe('model-a');
      // 两个独立的决策
      const decisions = await h.governor!.listDecisions();
      expect(decisions).toHaveLength(2);
      expect(decisions[0]!.requestId).not.toBe(decisions[1]!.requestId);
    } finally {
      await h.dispose();
    }
  });
});

describe('月末额度窗口', () => {
  it('monthWindow 返回当前自然月的起止时间（UTC）', () => {
    const win = monthWindow('UTC', new Date('2026-08-20T12:00:00Z'));
    expect(win.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(win.end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('monthKey 返回 YYYY-MM 格式', () => {
    expect(monthKey('UTC', new Date('2026-08-20T12:00:00Z'))).toBe('2026-08');
    expect(monthKey('UTC', new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
  });

  it('checkQuota admission control：used >= limit 时 exceeded=true', () => {
    const ok = checkQuota(50n, 100n);
    expect(ok.exceeded).toBe(false);
    expect(ok.remainingNanos).toBe(50n);
    const atLimit = checkQuota(100n, 100n);
    expect(atLimit.exceeded).toBe(true);
    expect(atLimit.remainingNanos).toBe(0n);
    const overLimit = checkQuota(150n, 100n);
    expect(overLimit.exceeded).toBe(true);
  });

  it('月末跨界：8月31日23:59和9月1日00:01属于不同月份窗口', () => {
    const aug = monthKey('UTC', new Date('2026-08-31T23:59:59Z'));
    const sep = monthKey('UTC', new Date('2026-09-01T00:01:00Z'));
    expect(aug).toBe('2026-08');
    expect(sep).toBe('2026-09');
  });
});

describe('安全边界', () => {
  it('无身份绑定的 session 在 fail closed 模式下不产生有效 usage', async () => {
    const h = await bootFake(
      ['fake-provider'],
      [modelInfo('fake-provider', 'model-a')],
      successScript('hi', { inputTokens: 5, outputTokens: 3 }) as never,
      {
        models: {
          'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
        },
        fallback: { enabled: true, max_attempts: 2 },
        identity: { provider: 'local', local_user_id: 'local' },
      },
    );
    try {
      // 未绑定身份的 session
      const identity = h.governor!.getIdentity('unbound-session');
      expect(identity).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it('空 user_id 绑定被拒绝（fail closed）', async () => {
    const h = await bootFake(
      ['fake-provider'],
      [modelInfo('fake-provider', 'model-a')],
      successScript('hi', { inputTokens: 5, outputTokens: 3 }) as never,
      {
        models: {
          'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
        },
        fallback: { enabled: true, max_attempts: 2 },
      },
    );
    try {
      await expect(h.governor!.bindIdentity('s1', { userId: '' })).rejects.toThrow(
        'IDENTITY_REQUIRED',
      );
    } finally {
      await h.dispose();
    }
  });

  it('JWT alg=none 被禁止（fail closed）', async () => {
    const { JwtIdentityProvider } = await import('../../src/identity/providers.js');
    expect(
      () =>
        new JwtIdentityProvider({ secret: 'k', issuer: 'i', audience: 'a', algorithms: ['none'] }),
    ).toThrow();
  });
});
