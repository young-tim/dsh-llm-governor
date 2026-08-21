/**
 * Storage 模块单元测试：覆盖数据库初始化、迁移、CRUD、幂等、事务。
 * 每个测试使用独立的临时数据库，互不影响。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';
import type { ModelPolicyRow, UsageEventRow } from '../../src/storage/repository.js';
import { sealDecision } from '../../src/routing/decision.js';
import type { SealedDecision, SealDecisionInput } from '../../src/routing/decision.js';

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

/** 构造一个最小 SealedDecision（GOV-DECISION-001 统一 Decision 类型）。 */
function sampleDecision(overrides: Partial<SealDecisionInput> = {}): SealedDecision {
  return sealDecision({
    requestId: 'req-1',
    turn: 1,
    step: 1,
    fallbackIndex: 0,
    causes: ['initial'],
    changedFields: [],
    selectionMode: 'auto',
    effectiveStrategy: 'credit_first',
    candidates: [{ routeId: 'fake-provider:model-a', quality: 90, multiplierPpm: 1_000_000 }],
    excluded: [],
    outcome: 'selected',
    selectedRoute: 'fake-provider:model-a',
    configRevision: 1,
    ...overrides,
  });
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

describe('决策记录（幂等 + DECISION_CONFLICT + 审计状态）', () => {
  it('insertSealedDecision + getDecisions：统一 Decision 视图', () => {
    const result = repo.insertSealedDecision(sampleDecision(), { sessionId: 'session-1' });
    expect(result).toBe('inserted');
    const decisions = repo.getDecisions('req-1');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.requestId).toBe('req-1');
    expect(decisions[0]!.fallbackIndex).toBe(0);
    expect(decisions[0]!.mode).toBe('credit_first');
    expect(decisions[0]!.selectedRoute).toBe('fake-provider:model-a');
    expect(decisions[0]!.configRevision).toBe(1);
    expect(decisions[0]!.candidates).toHaveLength(1);
    expect(decisions[0]!.candidates[0]!.routeId).toBe('fake-provider:model-a');
    expect(decisions[0]!.auditState).toBe('pending');
    expect(decisions[0]!.sessionId).toBe('session-1');
    expect(decisions[0]!.turn).toBe(1);
    expect(decisions[0]!.decisionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('重复插入相同 decisionId+hash 返回 exists（幂等）', () => {
    repo.insertSealedDecision(sampleDecision(), { sessionId: 'session-1' });
    const result = repo.insertSealedDecision(sampleDecision(), { sessionId: 'session-1' });
    expect(result).toBe('exists');
    expect(repo.getDecisions('req-1')).toHaveLength(1);
  });

  it('相同 decisionId 但不同 hash 抛 DECISION_CONFLICT（不覆盖不静默）', () => {
    repo.insertSealedDecision(sampleDecision(), { sessionId: 'session-1' });
    expect(() =>
      repo.insertSealedDecision(
        sampleDecision({ selectedRoute: 'fake-provider:model-b', outcome: 'selected' }),
        { sessionId: 'session-1' },
      ),
    ).toThrowError(/DECISION_CONFLICT/);
    // 原决策未被覆盖
    expect(repo.getDecisions('req-1')[0]!.selectedRoute).toBe('fake-provider:model-a');
  });

  it('markDecisionCommitted：hash 匹配的 pending 才被 CAS 为 committed', () => {
    const decision = sampleDecision();
    repo.insertSealedDecision(decision, { sessionId: 'session-1' });
    expect(repo.markDecisionCommitted(decision.decisionId, decision.decisionHash)).toBe(true);
    expect(repo.getDecisions('req-1')[0]!.auditState).toBe('committed');
    // 已 committed 的行不再被重复 CAS
    expect(repo.markDecisionCommitted(decision.decisionId, decision.decisionHash)).toBe(false);
    // hash 不匹配的 CAS 失败
    const other = sampleDecision({ requestId: 'req-other' });
    repo.insertSealedDecision(other, { sessionId: 'session-1' });
    expect(repo.markDecisionCommitted(other.decisionId, 'deadbeef')).toBe(false);
    expect(repo.getDecisions('req-other')[0]!.auditState).toBe('pending');
  });

  it('listPendingDecisions 列出待对账决策', () => {
    repo.insertSealedDecision(sampleDecision(), { sessionId: 'session-1' });
    repo.insertSealedDecision(sampleDecision({ requestId: 'req-2', fallbackIndex: 0 }), {
      sessionId: 'session-1',
    });
    repo.markDecisionCommitted('req-1:0', sampleDecision().decisionHash);
    const pending = repo.listPendingDecisions();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.decisionId).toBe('req-2:0');
  });

  it('queryDecisions 分页：默认 50、上限 200、按 (createdAt DESC, decisionId DESC) 稳定排序', () => {
    for (let i = 0; i < 5; i++) {
      repo.insertSealedDecision(sampleDecision({ requestId: `req-${i}`, fallbackIndex: 0 }), {
        sessionId: 'session-1',
      });
    }
    const page1 = repo.queryDecisions({ sessionId: 'session-1', limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = repo.queryDecisions({
      sessionId: 'session-1',
      limit: 2,
      cursor: page1.nextCursor,
    });
    const ids = [...page1.items.map((d) => d.decisionId), ...page2.items.map((d) => d.decisionId)];
    expect(new Set(ids).size).toBe(4);
    // 超上限被钳制为 200
    expect(repo.queryDecisions({ limit: 999 }).items.length).toBeLessThanOrEqual(200);
  });
});

describe('配置 revision 与审计（GOV-CONFIG-001 / GOV-SEC-001）', () => {
  it('configRevision 初始 0，bootstrap 后单调递增', () => {
    expect(repo.getConfigRevision()).toBe(0);
    repo.setConfigRevision(1);
    expect(repo.getConfigRevision()).toBe(1);
    repo.setConfigRevision(2);
    expect(repo.getConfigRevision()).toBe(2);
  });

  it('bootstrap 来源只写一次（重启不覆盖）', () => {
    repo.setBootstrapSource('yaml-bootstrap:1');
    repo.setBootstrapSource('yaml-bootstrap:2');
    expect(repo.getBootstrapSource()).toBe('yaml-bootstrap:1');
  });

  it('insertAuditEntry + listAuditEntries', () => {
    repo.insertAuditEntry({
      actor: 'admin',
      action: 'updateModel',
      target: 'fake-provider:model-a',
      changedFields: ['enabled'],
      oldRevision: 1,
      newRevision: 2,
      result: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const entries = repo.listAuditEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('admin');
    expect(entries[0]!.changedFields).toEqual(['enabled']);
    expect(entries[0]!.newRevision).toBe(2);
  });
});

describe('attempt 生命周期（GOV-ATTEMPT-001）', () => {
  it('upsertAttemptState + getAttemptState', () => {
    repo.upsertAttemptState('req-1', 0, 'not_dispatched');
    expect(repo.getAttemptState('req-1', 0)).toBe('not_dispatched');
    repo.upsertAttemptState('req-1', 0, 'dispatch_started');
    expect(repo.getAttemptState('req-1', 0)).toBe('dispatch_started');
    repo.upsertAttemptState('req-1', 0, 'completed');
    expect(repo.getAttemptState('req-1', 0)).toBe('completed');
    expect(repo.getAttemptState('req-none', 0)).toBeUndefined();
  });
});

describe('数据库迁移（GOV-STORAGE-001）', () => {
  it('v1 → v2 迁移：旧决策行派生 decision_id，缺失字段为 unknown，备份表保留', () => {
    // 构造一个 v1 形态的旧库（独立目录，不影响 beforeEach 的 db）
    const legacyDir = mkdtempSync(join(tmpdir(), 'gov-storage-legacy-'));
    const legacyPath = join(legacyDir, 'legacy.db');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
    );
    legacy.exec(
      `INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z')`,
    );
    legacy.exec(`CREATE TABLE routing_decisions (
      request_id TEXT NOT NULL, fallback_index INTEGER NOT NULL, mode TEXT NOT NULL,
      task_type TEXT, complexity TEXT, confidence REAL, minimum_quality INTEGER,
      candidates_json TEXT NOT NULL, excluded_json TEXT NOT NULL, selected_route TEXT NOT NULL,
      config_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (request_id, fallback_index))`);
    legacy.exec(`CREATE TABLE usage_events (
      request_id TEXT NOT NULL, fallback_index INTEGER NOT NULL, session_id TEXT NOT NULL,
      turn INTEGER NOT NULL, step INTEGER NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, routing_mode TEXT NOT NULL, task_type TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      credit_nanos INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL, finish_kind TEXT,
      error_code TEXT, http_status INTEGER, latency_ms INTEGER NOT NULL,
      attempt_origin TEXT NOT NULL DEFAULT 'middleware_or_unknown', usage_missing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, PRIMARY KEY (request_id, fallback_index))`);
    legacy.exec(`INSERT INTO routing_decisions
      (request_id, fallback_index, mode, task_type, complexity, confidence, minimum_quality,
       candidates_json, excluded_json, selected_route, config_revision, created_at)
      VALUES ('legacy-req', 0, 'auto', 'coding', 'high', 0.9, 85, '[]', '[]',
              'fake-provider:model-a', 1, '2026-01-01T00:00:00.000Z')`);
    legacy.close();
    // 重新打开：触发 v2 迁移（重建 + 数据搬迁 + 备份）
    const upgradedDb = new GovernorDatabase(legacyPath);
    const upgradedRepo = new GovernorRepository(upgradedDb);
    const decisions = upgradedRepo.getDecisions('legacy-req');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decisionId).toBe('legacy-req:0');
    expect(decisions[0]!.auditState).toBe('committed');
    expect(decisions[0]!.outcome).toBe('selected');
    expect(decisions[0]!.selectedRoute).toBe('fake-provider:model-a');
    // v2 新字段在旧行上为 unknown（不伪造）
    expect(decisions[0]!.trigger).toBeUndefined();
    expect(decisions[0]!.causes).toBeUndefined();
    expect(decisions[0]!.selectionMode).toBeUndefined();
    expect(decisions[0]!.sessionId).toBeUndefined();
    // 备份表保留旧行（可校验恢复）
    const backup = upgradedDb.prepare('SELECT COUNT(*) AS n FROM routing_decisions_v1_backup');
    expect((backup.get() as { n: number }).n).toBe(1);
    // 重复打开幂等（迁移只应用一次）
    upgradedDb.close();
    const reopened = new GovernorDatabase(legacyPath);
    const again = new GovernorRepository(reopened).getDecisions('legacy-req');
    expect(again).toHaveLength(1);
    reopened.close();
    rmSync(legacyDir, { recursive: true, force: true });
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
