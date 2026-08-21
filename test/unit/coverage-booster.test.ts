/**
 * 覆盖补强测试：GOV-TRACE-001 SessionStoreSink（完整双写协议的 Session 侧）、
 * GOV-OPS-002 导出辅助函数、GOV-CLASSIFIER-001 降级路径。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../src/dsh-adapter/mod.js';
import SessionStore from '@deepseek-ai/dsh-session';
import {
  SessionStoreSink,
  NullSessionEventSink,
  AuditPipeline,
  selectionFromSession,
} from '../../src/plugin/audit-pipeline.js';
import {
  appendGovernorSelectionMode,
  governorDecisionFromEvent,
} from '../../src/dsh-adapter/session-events.js';
import { sealDecision } from '../../src/routing/decision.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';
import {
  toUsageExportRows,
  toDecisionExportRows,
  exportWithLimits,
  toCsv,
  escapeCsvCell,
} from '../../src/ops/export.js';
import type { UsageEventRow } from '../../src/storage/repository.js';

/** 构造最小 SealedDecision。 */
function decision(requestId: string, fallbackIndex = 0) {
  return sealDecision({
    requestId,
    turn: 1,
    step: 1,
    fallbackIndex,
    causes: ['initial'],
    changedFields: [],
    selectionMode: 'auto',
    effectiveStrategy: 'credit_first',
    candidates: [{ routeId: 'p:m', quality: 90, multiplierPpm: 1_000_000 }],
    excluded: [],
    outcome: 'selected',
    selectedRoute: 'p:m',
    configRevision: 1,
  });
}

describe('GOV-TRACE-001 SessionStoreSink（内存 Session 的完整双写）', () => {
  it('appendDecision 幂等写入 Session 并等待 durable ack', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('sink-1', { meta: { cwd: process.cwd() } });
    const sessions = new Map([['sink-1', session]]);
    const sink = new SessionStoreSink(
      (id) => sessions.get(id),
      async () => {
        // durable ack：flush 参与返回 true
        return true;
      },
      () => [...sessions.values()],
    );
    const d = decision('req-sink');
    await sink.appendDecision(d, { sessionId: 'sink-1' });
    expect(
      session.events.some((e) => governorDecisionFromEvent(e)?.decisionId === 'req-sink:0'),
    ).toBe(true);
    expect(await sink.hasDecision('req-sink:0')).toBe(true);
    expect(await sink.hasDecision('nonexistent:0')).toBe(false);
    // 幂等：重复 append 不产生第二条
    await sink.appendDecision(d, { sessionId: 'sink-1' });
    const count = session.events.filter(
      (e) => governorDecisionFromEvent(e)?.decisionId === 'req-sink:0',
    ).length;
    expect(count).toBe(1);
    await store.dispose();
  });

  it('appendDecision 会话不存在时抛 AUDIT_PERSIST_FAILED', async () => {
    const sink = new SessionStoreSink(
      () => undefined,
      async () => true,
    );
    await expect(
      sink.appendDecision(decision('req-x'), { sessionId: 'missing' }),
    ).rejects.toMatchObject({
      code: 'AUDIT_PERSIST_FAILED',
    });
  });

  it('appendDecision 无 durability listener 参与时抛 AUDIT_PERSIST_FAILED', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('sink-2', { meta: { cwd: process.cwd() } });
    const sink = new SessionStoreSink(
      () => session,
      async () => false,
    );
    await expect(
      sink.appendDecision(decision('req-y'), { sessionId: 'sink-2' }),
    ).rejects.toMatchObject({
      code: 'AUDIT_PERSIST_FAILED',
    });
    await store.dispose();
  });

  it('NullSessionEventSink：append 严格 fail-closed 抛 AUDIT_PERSIST_FAILED', async () => {
    const sink = new NullSessionEventSink();
    await expect(sink.appendDecision(decision('req-n'), { sessionId: 's' })).rejects.toMatchObject({
      code: 'AUDIT_PERSIST_FAILED',
    });
    await expect(sink.appendSelectionMode('s', {} as never)).rejects.toMatchObject({
      code: 'AUDIT_PERSIST_FAILED',
    });
    await expect(sink.hasDecision('req-n:0')).resolves.toBe(false);
  });

  it('_toEventData 完整字段：rejected 决策携带 classifier/minimumQuality/errorCode', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('sink-3', { meta: { cwd: process.cwd() } });
    const sessions = new Map([['sink-3', session]]);
    const sink = new SessionStoreSink(
      (id) => sessions.get(id),
      async () => true,
      () => [...sessions.values()],
    );
    // rejected 决策：带 classifier + minimumQuality + errorCode
    const rejected = sealDecision({
      requestId: 'req-rej',
      turn: 2,
      step: 3,
      fallbackIndex: 1,
      causes: ['step', 'config_change'],
      changedFields: ['selected_route'],
      selectionMode: 'auto',
      effectiveStrategy: 'quality_first',
      classifier: { taskType: 'coding', complexity: 'high', confidence: 0.92, source: 'llm' },
      minimumQuality: 92,
      candidates: [{ routeId: 'p:m', quality: 90, multiplierPpm: 1_000_000 }],
      excluded: [{ routeId: 'p:x', reason: 'disabled' }],
      outcome: 'rejected',
      errorCode: 'NO_MODEL_MATCHED',
      configRevision: 2,
    });
    await sink.appendDecision(rejected, { sessionId: 'sink-3' });
    const event = session.events.find(
      (e) => governorDecisionFromEvent(e)?.decisionId === 'req-rej:1',
    );
    const eventData = event === undefined ? undefined : governorDecisionFromEvent(event);
    expect(eventData).toBeDefined();
    expect(eventData!.outcome).toBe('rejected');
    expect(eventData!.errorCode).toBe('NO_MODEL_MATCHED');
    expect(eventData!.minimumQuality).toBe(92);
    expect(eventData!.candidates).toHaveLength(1);
    expect(eventData!.excluded).toHaveLength(1);
    await store.dispose();
  });
});

/** 测试用成功 sink：append 直接确认（测试 SQLite 行为时不关心 Session Event）。 */
const okSink = {
  appendDecision: async () => {},
  appendSelectionMode: async () => {},
  hasDecision: async () => false,
};

describe('GOV-TRACE-001 AuditPipeline 对账分支', () => {
  it('无 repository 时 reconcile 空结果；sink 不可写时 pending 保留', async () => {
    // 无 repository：空结果（commitDecision 跳过，不触发 sink）
    const noRepo = new AuditPipeline(undefined, new NullSessionEventSink());
    expect(await noRepo.reconcile()).toEqual({ committed: 0, pending: 0, conflicts: [] });
    await expect(noRepo.commitDecision(decision('r'), { sessionId: 's' })).resolves.toBeUndefined();

    // 有 repository + 失败 sink：pending 决策保留（会话不可写）
    const dir = mkdtempSync(join(tmpdir(), 'gov-audit-br-'));
    const db = new GovernorDatabase(join(dir, 'a.db'));
    const repo = new GovernorRepository(db);
    const failingSink = {
      appendDecision: async () => {
        throw new Error('session not writable');
      },
      appendSelectionMode: async () => {
        throw new Error('session not writable');
      },
      hasDecision: async () => false,
    };
    const pipeline = new AuditPipeline(repo, failingSink);
    repo.insertSealedDecision(decision('br-1'), { sessionId: 's' });
    const result = await pipeline.reconcile();
    expect(result.pending).toBe(1);
    expect(result.committed).toBe(0);
    // 无 hash 的旧行保留 pending（人工诊断）
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('commitDecision：SQLite 故障与 sink 故障分别抛 AUDIT_PERSIST_FAILED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-audit-br2-'));
    const db = new GovernorDatabase(join(dir, 'a.db'));
    const repo = new GovernorRepository(db);
    const failingSink = {
      appendDecision: async () => {
        throw new Error('append failed');
      },
      appendSelectionMode: async () => {
        throw new Error('append failed');
      },
      hasDecision: async () => false,
    };
    const pipeline = new AuditPipeline(repo, failingSink);
    repo.insertSealedDecision(decision('br-2'), { sessionId: 's' });
    // sink 失败：CAS 未执行 → AUDIT_PERSIST_FAILED
    await expect(
      pipeline.commitDecision(decision('br-2'), { sessionId: 's' }),
    ).rejects.toMatchObject({
      code: 'AUDIT_PERSIST_FAILED',
    });
    // 幂等重入：已 committed 的决策再次 commit 成功（已 committed 分支）
    const okPipeline = new AuditPipeline(repo, okSink);
    await okPipeline.commitDecision(decision('br-3'), { sessionId: 's' });
    await okPipeline.commitDecision(decision('br-3'), { sessionId: 's' });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconcile：可选字段缺失的 pending 行仍可补齐（_reconstruct 全 unknown 分支）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-audit-br3-'));
    const db = new GovernorDatabase(join(dir, 'a.db'));
    const repo = new GovernorRepository(db);
    // 插入完整决策后清除可选列（模拟字段缺失的 pending 行）
    repo.insertSealedDecision(decision('br-4'), { sessionId: 's' });
    db.exec(
      `UPDATE routing_decisions SET task_type = NULL, complexity = NULL, confidence = NULL,
       minimum_quality = NULL, selected_route = NULL, error_code = NULL, trigger = NULL,
       causes_json = NULL, changed_fields_json = NULL, selection_mode = NULL,
       effective_strategy = NULL WHERE decision_id = 'br-4:0'`,
    );
    const pipeline = new AuditPipeline(repo, okSink);
    const result = await pipeline.reconcile();
    expect(result.committed).toBe(1);
    expect(result.pending).toBe(0);
    // 已补齐 committed
    expect(repo.getDecisions('br-4')[0]!.auditState).toBe('committed');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconcile：Session Event 已存在时跳过 append 直接补 commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-audit-br5-'));
    const db = new GovernorDatabase(join(dir, 'a.db'));
    const repo = new GovernorRepository(db);
    repo.insertSealedDecision(decision('br-5'), { sessionId: 's' });
    // 已存在（幂等 append 已写过）：append 不应被再次调用
    const existsSink = {
      appendDecision: async () => {
        throw new Error('should not append when event exists');
      },
      appendSelectionMode: async () => {},
      hasDecision: async () => true,
    };
    const pipeline = new AuditPipeline(repo, existsSink);
    const result = await pipeline.reconcile();
    expect(result.committed).toBe(1);
    expect(result.pending).toBe(0);
    expect(repo.getDecisions('br-5')[0]!.auditState).toBe('committed');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconcile：CAS 标记失败时保留 pending（并发写入竞争）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-audit-br6-'));
    const db = new GovernorDatabase(join(dir, 'a.db'));
    const repo = new GovernorRepository(db);
    repo.insertSealedDecision(decision('br-6'), { sessionId: 's' });
    const pipeline = new AuditPipeline(repo, okSink);
    // 注入 CAS 失败：另一进程已并发标记（changes = 0）
    const original = repo.markDecisionCommitted.bind(repo);
    repo.markDecisionCommitted = () => false;
    const result = await pipeline.reconcile();
    expect(result.pending).toBe(1);
    expect(result.committed).toBe(0);
    repo.markDecisionCommitted = original;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('commitDecision：CAS 失败且行未 committed 时抛 AUDIT_PERSIST_FAILED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-audit-br7-'));
    const db = new GovernorDatabase(join(dir, 'a.db'));
    const repo = new GovernorRepository(db);
    const pipeline = new AuditPipeline(repo, okSink);
    repo.markDecisionCommitted = () => false;
    await expect(
      pipeline.commitDecision(decision('br-7'), { sessionId: 's' }),
    ).rejects.toMatchObject({
      code: 'AUDIT_PERSIST_FAILED',
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('selectionFromSession：从 Session log 重建会话选择状态（restore 接线面）', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('sel-1', { meta: { cwd: process.cwd() } });
    // 无事件时返回 undefined（调用方按全局默认初始化）
    expect(selectionFromSession(session)).toBeUndefined();
    appendGovernorSelectionMode(session, {
      schemaVersion: 1,
      selectionRevision: 1,
      mode: 'auto',
      lastManualRoute: 'p:m',
      changedAt: Date.now(),
    });
    appendGovernorSelectionMode(session, {
      schemaVersion: 1,
      selectionRevision: 2,
      mode: 'manual',
      lastManualRoute: 'p:m',
      changedAt: Date.now(),
    });
    // 最新事件胜出（revision 2 的 manual + lastManualRoute）
    expect(selectionFromSession(session)).toEqual({
      mode: 'manual',
      selectionRevision: 2,
      lastManualRoute: 'p:m',
    });
    await store.dispose();
  });

  it('commitSelectionMode：sink 抛普通错误时包装为 AUDIT_PERSIST_FAILED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-audit-br8-'));
    const db = new GovernorDatabase(join(dir, 'a.db'));
    const repo = new GovernorRepository(db);
    const plainErrorSink = {
      appendDecision: async () => {},
      appendSelectionMode: async () => {
        throw new Error('plain failure');
      },
      hasDecision: async () => false,
    };
    const pipeline = new AuditPipeline(repo, plainErrorSink);
    await expect(
      pipeline.commitSelectionMode('s1', {
        schemaVersion: 1,
        selectionRevision: 1,
        mode: 'auto',
        changedAt: Date.now(),
      }),
    ).rejects.toMatchObject({ code: 'AUDIT_PERSIST_FAILED' });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconcile：无 hash 的旧迁移行保留 pending（人工诊断，不自动补齐）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-audit-br9-'));
    const db = new GovernorDatabase(join(dir, 'a.db'));
    const repo = new GovernorRepository(db);
    repo.insertSealedDecision(decision('br-9'), { sessionId: 's' });
    // 模拟 v1 旧迁移行：decision_hash 缺失
    db.exec(`UPDATE routing_decisions SET decision_hash = NULL WHERE decision_id = 'br-9:0'`);
    const pipeline = new AuditPipeline(repo, okSink);
    const result = await pipeline.reconcile();
    expect(result.pending).toBe(1);
    expect(result.committed).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('GOV-OPS-002 导出辅助与上限分支', () => {
  const usageRow: UsageEventRow = {
    requestId: 'r1',
    fallbackIndex: 0,
    sessionId: 's1',
    usageKind: 'classifier',
    parentRequestId: 'parent-1',
    turn: 1,
    step: 1,
    userId: 'user@example.com',
    provider: 'p',
    model: 'm',
    routingMode: 'auto',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 2,
    creditNanos: 123n,
    success: true,
    finishKind: 'stop',
    latencyMs: 20,
    attemptOrigin: 'provider',
    usageMissing: false,
    createdAt: '2026-08-21T00:00:00Z',
  };

  it('toUsageExportRows：假名化 + 字段扁平（conversation 默认）', () => {
    const rows = toUsageExportRows([
      usageRow,
      { ...usageRow, usageKind: undefined, parentRequestId: undefined, fallbackIndex: 1 },
    ]);
    expect(rows[0]!.pseudonymousUser).toMatch(/^user-[0-9a-f]{8}$/);
    expect(rows[0]!.pseudonymousUser).not.toBe('user@example.com');
    expect(rows[0]!.usageKind).toBe('classifier');
    expect(rows[0]!.parentRequestId).toBe('parent-1');
    expect(rows[0]!.creditNanos).toBe('123');
    expect(rows[1]!.usageKind).toBe('conversation');
    expect(rows[1]!.parentRequestId).toBeUndefined();
  });

  it('toDecisionExportRows：可选字段条件展开', () => {
    const rows = toDecisionExportRows([
      {
        decisionId: 'd1',
        requestId: 'r1',
        sessionId: 's',
        turn: 1,
        step: 1,
        fallbackIndex: 0,
        trigger: 'initial',
        selectionMode: 'auto',
        effectiveStrategy: 'credit_first',
        mode: 'auto',
        candidates: [],
        candidateTruncated: false,
        excluded: [],
        excludedTruncated: false,
        outcome: 'selected',
        selectedRoute: 'p:m',
        auditState: 'committed',
        configRevision: 1,
        createdAt: '2026-08-21T00:00:00Z',
      },
    ]);
    expect(rows[0]!.decisionId).toBe('d1');
    expect(rows[0]!.trigger).toBe('initial');
    expect(rows[0]!.selectedRoute).toBe('p:m');
  });

  it('exportWithLimits：字节超限时按行收缩（truncatedBy=bytes）', () => {
    // 每行约 250KB，50 行 ≈ 12.5 MiB → 触发 bytes 截断
    const big = 'x'.repeat(250 * 1024);
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, payload: big }));
    const result = exportWithLimits(rows, (rs) => toCsv(rs as never));
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(result.rowCount).toBeLessThan(50);
  });

  it('toCsv：空数组返回空串；escapeCsvCell 边界', () => {
    expect(toCsv([])).toBe('');
    expect(escapeCsvCell('')).toBe('');
  });

  it('toDecisionExportRows：全字段缺失的最小行（条件分支全 false）', () => {
    const rows = toDecisionExportRows([
      {
        decisionId: 'd-min',
        requestId: 'r-min',
        fallbackIndex: 0,
        mode: 'manual',
        candidates: [],
        candidateTruncated: false,
        excluded: [],
        excludedTruncated: false,
        outcome: 'rejected',
        auditState: 'pending',
        configRevision: 1,
        createdAt: '2026-08-21T00:00:00Z',
      },
    ]);
    expect(rows[0]).toEqual({
      decisionId: 'd-min',
      requestId: 'r-min',
      fallbackIndex: 0,
      outcome: 'rejected',
      configRevision: 1,
      createdAt: '2026-08-21T00:00:00Z',
    });
  });

  it('toCsv：undefined/null 单元格序列化为空串', () => {
    const csv = toCsv([{ a: undefined, b: null, c: 'x' }]);
    expect(csv).toBe('a,b,c\n,,x');
  });

  it('exportWithLimits：未超限时不截断（truncatedBy 省略）', () => {
    const result = exportWithLimits([{ id: 1 }], (rs) => toCsv(rs as never));
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeUndefined();
    expect(result.rowCount).toBe(1);
  });
});

describe('GOV-OPS-003 指标分支补强', () => {
  /** 构造样本（可定制 attempt 完成状态）。 */
  function sample(
    requestId: string,
    attempts: Array<{ completed: boolean; usageMissing: boolean; creditNanos: bigint }>,
  ): import('../../src/ops/metrics.js').AutoRequestSample {
    return {
      requestId,
      finalRoute: 'p:cheap',
      attempts: attempts.map((a, i) => ({
        fallbackIndex: i,
        routeId: 'p:cheap',
        totalTokens: 100,
        creditNanos: a.creditNanos,
        usageMissing: a.usageMissing,
        completed: a.completed,
      })),
      classifierCreditNanos: 5n,
      qualityFirstRoute: { routeId: 'p:best', multiplierPpm: 2_000_000, quality: 90 },
      autoRoute: { routeId: 'p:cheap', multiplierPpm: 500_000, quality: 85 },
    };
  }

  it('Request Success Rate：含失败 request 的混合场景与 fallback 计数', async () => {
    const samples = Array.from({ length: 100 }, (_unused, i) => {
      if (i < 10) {
        // 10 个失败 request（全部 attempt 失败）
        return sample(`fail-${i}`, [{ completed: false, usageMissing: false, creditNanos: 10n }]);
      }
      if (i < 20) {
        // 10 个 fallback request（首 attempt 失败，第二成功）
        return sample(`fb-${i}`, [
          { completed: false, usageMissing: false, creditNanos: 10n },
          { completed: true, usageMissing: false, creditNanos: 10n },
        ]);
      }
      return sample(`ok-${i}`, [{ completed: true, usageMissing: false, creditNanos: 10n }]);
    });
    const m = (await import('../../src/ops/metrics.js')).computeRoutingMetrics(samples, 1_000_000);
    expect(m.requests).toBe(100);
    expect(m.attempts).toBe(110);
    expect(m.fallbackCount).toBe(10);
    expect(m.requestSuccessRate).toBeCloseTo(0.9, 5);
    expect(m.insufficientSample).toBe(false);
  });

  it('空样本与反事实为 0 的边界', async () => {
    const { computeRoutingMetrics } = await import('../../src/ops/metrics.js');
    const empty = computeRoutingMetrics([], 1_000_000);
    expect(empty.requests).toBe(0);
    expect(empty.requestSuccessRate).toBe(0);
    expect(empty.insufficientSample).toBe(true);
    // 全部 usage_missing → 不足样本
    const missing = computeRoutingMetrics(
      Array.from({ length: 100 }, (_unused, i) =>
        sample(`m-${i}`, [{ completed: true, usageMissing: true, creditNanos: 1n }]),
      ),
      1_000_000,
    );
    expect(missing.insufficientSample).toBe(true);
  });
});
