/**
 * Storage 模块单元测试：覆盖数据库初始化、迁移、CRUD、幂等、事务。
 * 每个测试使用独立的临时数据库，互不影响。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';
import type { ModelPolicyRow, UsageEventRow } from '../../src/storage/repository.js';
import type { DecisionRecord } from '../../src/routing/types.js';

// 抑制 node:sqlite 的 ExperimentalWarning
const originalEmit = process.emit;
process.emit = function (name, ...args) {
  if (name === 'warning' && args[0]?.name === 'ExperimentalWarning') return false;
  return originalEmit.apply(process, [name, ...args]);
} as never;

// ===== 测试夹具 =====

/** 构造一个最小 ModelPolicyRow。 */
function sampleModelPolicy(overrides: Partial<ModelPolicyRow> = {}): ModelPolicyRow {
  return {
    routeId: 'fake-provider:model-a',
    provider: 'fake-provider',
    model: 'model-a',
    enabled: true,
    multiplierPpm: 1_000_000,
    capabilities: ['chat'],
    quality: { general: 90 },
    ...overrides,
  };
}

/** 构造一个最小 DecisionRecord。 */
function sampleDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    requestId: 'req-1',
    fallbackIndex: 0,
    mode: 'auto',
    candidates: [{ routeId: 'fake-provider:model-a', quality: 90, multiplierPpm: 1_000_000 }],
    excluded: [],
    selected: 'fake-provider:model-a',
    configRevision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 构造一个最小 UsageEventRow。 */
function sampleUsageEvent(overrides: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    requestId: 'req-1',
    fallbackIndex: 0,
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
    attemptOrigin: 'middleware_or_unknown',
    usageMissing: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ===== 生命周期 =====

let tempDir: string;
let db: GovernorDatabase;
let repo: GovernorRepository;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gov-storage-'));
  db = new GovernorDatabase(join(tempDir, 'test.db'));
  repo = new GovernorRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ===== 测试用例 =====

describe('数据库初始化', () => {
  it('WAL 模式启用（PRAGMA journal_mode 返回 wal）', () => {
    const stmt = db.prepare('PRAGMA journal_mode');
    const row = stmt.get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
  });

  it('迁移表 schema_migrations 存在且 version=1', () => {
    // 检查表存在
    const tableStmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    );
    const tableRow = tableStmt.get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('schema_migrations');

    // 检查 version=1 已应用
    const stmt = db.prepare('SELECT version FROM schema_migrations ORDER BY version');
    const rows = stmt.all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toContain(1);
  });

  it('所有表存在', () => {
    const expected = [
      'model_policies',
      'user_policies',
      'user_model_allow',
      'session_identities',
      'routing_decisions',
      'usage_events',
      'classifier_cache',
    ];
    const stmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const rows = stmt.all() as Array<{ name: string }>;
    const tables = new Set(rows.map((r) => r.name));
    for (const name of expected) {
      expect(tables.has(name)).toBe(true);
    }
  });

  it('索引存在', () => {
    const expected = [
      'idx_usage_user',
      'idx_usage_route',
      'idx_usage_mode',
      'idx_usage_request',
      'idx_decisions_request',
    ];
    const stmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
    );
    const rows = stmt.all() as Array<{ name: string }>;
    const indexes = new Set(rows.map((r) => r.name));
    for (const name of expected) {
      expect(indexes.has(name)).toBe(true);
    }
  });
});

describe('模型策略 CRUD', () => {
  it('upsertModelPolicy + listModelPolicies 插入并读取', () => {
    repo.upsertModelPolicy(sampleModelPolicy());
    const list = repo.listModelPolicies();
    expect(list).toHaveLength(1);
    expect(list[0]!.routeId).toBe('fake-provider:model-a');
    expect(list[0]!.provider).toBe('fake-provider');
    expect(list[0]!.model).toBe('model-a');
    expect(list[0]!.enabled).toBe(true);
    expect(list[0]!.multiplierPpm).toBe(1_000_000);
    expect(list[0]!.capabilities).toEqual(['chat']);
    expect(list[0]!.quality).toEqual({ general: 90 });
  });

  it('upsertModelPolicy 重复 route_id 更新', () => {
    repo.upsertModelPolicy(sampleModelPolicy());
    repo.upsertModelPolicy(
      sampleModelPolicy({
        model: 'model-b',
        enabled: false,
        multiplierPpm: 500_000,
        capabilities: ['chat', 'vision'],
        quality: { general: 80, coding: 85 },
      }),
    );
    const list = repo.listModelPolicies();
    expect(list).toHaveLength(1);
    expect(list[0]!.model).toBe('model-b');
    expect(list[0]!.enabled).toBe(false);
    expect(list[0]!.multiplierPpm).toBe(500_000);
    expect(list[0]!.capabilities).toEqual(['chat', 'vision']);
    expect(list[0]!.quality).toEqual({ general: 80, coding: 85 });
  });

  it('deleteModelPolicy 删除策略', () => {
    repo.upsertModelPolicy(sampleModelPolicy());
    repo.deleteModelPolicy('fake-provider:model-a');
    expect(repo.listModelPolicies()).toHaveLength(0);
  });
});

describe('用户策略', () => {
  it('upsertUserPolicy + getUserQuota 处理 bigint 额度', () => {
    repo.upsertUserPolicy('user-1', 5_000_000_000n);
    const quota = repo.getUserQuota('user-1');
    expect(quota).toBe(5_000_000_000n);
  });

  it('未设置的用户返回 undefined', () => {
    expect(repo.getUserQuota('nobody')).toBeUndefined();
  });
});

describe('用户白名单', () => {
  it('addUserAllow + listUserAllow', () => {
    repo.addUserAllow('user-1', 'fake-provider:model-a');
    repo.addUserAllow('user-1', 'fake-provider:model-b');
    expect(repo.listUserAllow('user-1')).toEqual([
      'fake-provider:model-a',
      'fake-provider:model-b',
    ]);
  });

  it('重复添加幂等（INSERT OR IGNORE）', () => {
    repo.addUserAllow('user-1', 'fake-provider:model-a');
    repo.addUserAllow('user-1', 'fake-provider:model-a');
    expect(repo.listUserAllow('user-1')).toEqual(['fake-provider:model-a']);
  });
});

describe('身份绑定', () => {
  it('upsertSessionIdentity + getSessionIdentity', () => {
    repo.upsertSessionIdentity('session-1', 'user-1', 'local', 1234567890, 'Alice');
    const identity = repo.getSessionIdentity('session-1');
    expect(identity).toBeDefined();
    expect(identity!.userId).toBe('user-1');
    expect(identity!.source).toBe('local');
    expect(identity!.expiresAt).toBe(1234567890);
  });

  it('更新同一 session 覆盖', () => {
    repo.upsertSessionIdentity('session-1', 'user-1', 'local');
    repo.upsertSessionIdentity('session-1', 'user-2', 'oauth', 9999999999);
    const identity = repo.getSessionIdentity('session-1');
    expect(identity!.userId).toBe('user-2');
    expect(identity!.source).toBe('oauth');
    expect(identity!.expiresAt).toBe(9999999999);
  });
});

describe('决策记录（幂等）', () => {
  it('insertDecision + getDecisions', () => {
    repo.insertDecision(sampleDecision());
    const decisions = repo.getDecisions('req-1');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.requestId).toBe('req-1');
    expect(decisions[0]!.fallbackIndex).toBe(0);
    expect(decisions[0]!.mode).toBe('auto');
    expect(decisions[0]!.selected).toBe('fake-provider:model-a');
    expect(decisions[0]!.configRevision).toBe(1);
    expect(decisions[0]!.candidates).toHaveLength(1);
    expect(decisions[0]!.candidates[0]!.routeId).toBe('fake-provider:model-a');
  });

  it('重复插入相同 request_id+fallback_index 被忽略（幂等）', () => {
    repo.insertDecision(sampleDecision());
    // 尝试用不同 selected 值再插入一次，应被忽略
    repo.insertDecision(sampleDecision({ selected: 'fake-provider:model-b' }));
    const decisions = repo.getDecisions('req-1');
    expect(decisions).toHaveLength(1);
    // 第一次写入的值应保留
    expect(decisions[0]!.selected).toBe('fake-provider:model-a');
  });
});

describe('Usage 事件（幂等）', () => {
  it('insertUsageEvent + queryUsage', () => {
    repo.insertUsageEvent(sampleUsageEvent());
    const rows = repo.queryUsage({ userId: 'user-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe('req-1');
    expect(rows[0]!.userId).toBe('user-1');
    expect(rows[0]!.provider).toBe('fake-provider');
    expect(rows[0]!.model).toBe('model-a');
    expect(rows[0]!.creditNanos).toBe(1_000_000n);
    expect(rows[0]!.success).toBe(true);
  });

  it('重复插入相同 request_id+fallback_index 被忽略（幂等）', () => {
    repo.insertUsageEvent(sampleUsageEvent());
    // 尝试用不同 creditNanos 再插入一次，应被忽略
    repo.insertUsageEvent(sampleUsageEvent({ creditNanos: 9_999_999n }));
    const rows = repo.queryUsage({ userId: 'user-1' });
    expect(rows).toHaveLength(1);
    // 第一次写入的值应保留
    expect(rows[0]!.creditNanos).toBe(1_000_000n);
  });

  it('sumUserCredits 返回已提交的 credit_nanos 总和（bigint）', () => {
    repo.insertUsageEvent(
      sampleUsageEvent({ requestId: 'r1', creditNanos: 1_000_000n, success: true }),
    );
    repo.insertUsageEvent(
      sampleUsageEvent({ requestId: 'r2', creditNanos: 2_500_000n, success: true }),
    );
    // 失败的不计入总和
    repo.insertUsageEvent(
      sampleUsageEvent({ requestId: 'r3', creditNanos: 9_000_000n, success: false }),
    );
    const total = repo.sumUserCredits(
      'user-1',
      '2025-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    );
    expect(total).toBe(3_500_000n);
  });
});

describe('事务', () => {
  it('transaction 成功时提交', () => {
    const result = db.transaction(() => {
      repo.upsertModelPolicy(sampleModelPolicy());
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(repo.listModelPolicies()).toHaveLength(1);
  });

  it('transaction 抛错时回滚', () => {
    expect(() =>
      db.transaction(() => {
        repo.upsertModelPolicy(sampleModelPolicy());
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // 回滚后应该没有数据
    expect(repo.listModelPolicies()).toHaveLength(0);
  });
});
