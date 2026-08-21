/**
 * 任务2 集成测试：双写审计协议（GOV-TRACE-001）与 attempt 生命周期（GOV-ATTEMPT-001）。
 *
 * 反向验证（任务书硬要求）：
 * - 注入 SQLite 写失败 → selectModel 抛 AUDIT_PERSIST_FAILED，fake Provider 调用数为 0。
 * - 注入 Session Event append 失败 → 同上 fail closed。
 * - 两者还原后 → 正常路径 Provider 恰好调用 1 次，全绿。
 * “测试变红”语义：若 fail-closed 被破坏（审计失败仍放行 Provider），
 * `expect(adapter.calls.length).toBe(0)` 立即失败，可捕获回归。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../src/dsh-adapter/mod.js';
import type { LlmModelInfo } from '../../src/dsh-adapter/mod.js';
import { LlmRuntime } from '../../src/dsh-adapter/mod.js';
import { FakeLlmAdapter } from '../../src/dsh-adapter/fake-adapter.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import { wireGovernorEvents } from '../../src/plugin/mod.js';
import { GovernorService } from '../../src/plugin/service.js';
import type { GovernorPluginConfig } from '../../src/plugin/service.js';
import type { SessionEventSink } from '../../src/plugin/audit-pipeline.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';
import { sealDecision } from '../../src/routing/decision.js';
import SessionStore from '@deepseek-ai/dsh-session';
import type { Session } from '@deepseek-ai/dsh-session';

const providers = ['fake-provider'];
const models: LlmModelInfo[] = [
  { provider: 'fake-provider', id: 'model-a', name: 'Model A' },
  { provider: 'fake-provider', id: 'model-b', name: 'Model B' },
];

/** 默认治理配置（manual 模式 + 本地身份）。 */
function baseConfig(): GovernorPluginConfig {
  return {
    identity: { provider: 'local', local_user_id: 'local' },
    routing: { default: 'manual' },
    models: {
      'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 },
      'fake-provider:model-b': { quality: { general: 80 }, multiplier: 0.5 },
    },
  } as GovernorPluginConfig;
}

/** 始终失败的 SessionEventSink（append 按开关抛错）。 */
class FailingSink implements SessionEventSink {
  public fail = false;

  /** 按开关抛错模拟 Session Event append 失败。 */
  async appendDecision(): Promise<void> {
    if (this.fail) throw new Error('session event append failed (injected)');
  }

  /** 无事件存在。 */
  async hasDecision(): Promise<boolean> {
    return false;
  }
}

/** 故障注入 harness：可注入 SQLite 写失败与 Session Event append 失败。 */
interface FaultHarness {
  ctx: Context;
  adapter: FakeLlmAdapter;
  governor: GovernorService;
  session: Session;
  repo: GovernorRepository;
  /** 注入/解除 SQLite 决策写入故障。 */
  setSqliteFault(on: boolean): void;
  /** 注入/解除 Session Event append 故障。 */
  setSinkFault(on: boolean): void;
  dispose: () => Promise<void>;
}

/** 启动带故障注入点的完整环境（复用 wireGovernorEvents 的正式接线）。 */
async function bootFaultHarness(): Promise<FaultHarness> {
  const ctx = new Context();
  const llm = ctx.plugin(LlmRuntime);
  await llm;
  const adapter = new FakeLlmAdapter(providers, models, successScript('ok', { inputTokens: 1, outputTokens: 1 }));
  const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
  const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-audit-'));
  const db = new GovernorDatabase(join(dbDir, 'governor.db'));
  const repo = new GovernorRepository(db);

  // SQLite 故障注入：按开关让 insertSealedDecision 抛错
  let sqliteFault = false;
  const realInsert = repo.insertSealedDecision.bind(repo);
  repo.insertSealedDecision = (decision, context) => {
    if (sqliteFault) throw new Error('sqlite write failed (injected)');
    return realInsert(decision, context);
  };

  // Session Event 故障注入：FailingSink
  const failingSink = new FailingSink();

  const store = ctx.plugin(SessionStore);
  await store;
  const session = ctx.sessions.create('audit-session-1', { meta: { cwd: dbDir } });

  const service = new GovernorService(ctx, baseConfig(), repo, { sessionEventSink: failingSink });
  try {
    await service.refreshModelDirectory(
      () => ctx.llm.listProviders(),
      (p) => ctx.llm.listModels(p),
    );
  } catch {
    // advisory 不可用时保留配置目录
  }
  await wireGovernorEvents(ctx, service);

  return {
    ctx,
    adapter,
    governor: service,
    session,
    repo,
    setSqliteFault: (on: boolean) => {
      sqliteFault = on;
    },
    setSinkFault: (on: boolean) => {
      failingSink.fail = on;
    },
    dispose: async () => {
      await store.dispose();
      db.close();
      disposeAdapter();
      await llm.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

/** 完整跑一次 pre-step → request → llm/stream 循环。 */
async function runAttempt(
  h: { ctx: Context; session: Session },
  turn: number,
  step: number,
): Promise<{ provider: string; model: string }> {
  const events = h.ctx.events as unknown as {
    waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
  };
  const payload = {
    agent: { id: h.session.id, options: {}, session: h.session, inbox: [], status: 'idle' },
    turn,
    step,
    signal: new AbortController().signal,
  };
  await events.waterfall('agent/pre-step', { ...payload, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
  const config = (await events.waterfall('agent/request', payload, async () => ({
    provider: 'fake-provider',
    model: 'model-a',
  }))) as { provider: string; model: string };
  const dispatch = { ...config, messages: [], sessionId: h.session.id };
  const stream = (await events.waterfall('llm/stream', dispatch, () =>
    (h.ctx.llm as unknown as { stream: (o: unknown) => AsyncIterable<unknown> }).stream(dispatch),
  )) as AsyncIterable<unknown>;
  for await (const _ of stream) void _;
  return config;
}

describe('GOV-TRACE-001 双写协议 fail closed（反向验证）', () => {
  it('SQLite 写失败：selectModel 抛 AUDIT_PERSIST_FAILED 且 fake Provider 调用数为 0', async () => {
    const h = await bootFaultHarness();
    try {
      h.setSqliteFault(true);
      const events = h.ctx.events as unknown as {
        waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
      };
      await expect(
        events.waterfall(
          'agent/request',
          {
            agent: { id: h.session.id, options: {}, session: h.session, inbox: [], status: 'idle' },
            turn: 1,
            step: 1,
            signal: new AbortController().signal,
          },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ).rejects.toMatchObject({ code: 'AUDIT_PERSIST_FAILED' });
      // 反向验证核心：审计失败后 fake Provider 调用数必须为 0。
      // 若 fail-closed 被破坏（错误被吞掉后仍放行），此断言变红。
      expect(h.adapter.calls.length).toBe(0);
      // 故障还原后同一路径恢复可用（Provider 恰好 1 次）。
      h.setSqliteFault(false);
      const config = await runAttempt(h, 1, 1);
      expect(config.provider).toBe('fake-provider');
      expect(h.adapter.calls.length).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it('Session Event append 失败：同样 fail closed，Provider 调用数为 0；还原后全绿', async () => {
    const h = await bootFaultHarness();
    try {
      h.setSinkFault(true);
      const events = h.ctx.events as unknown as {
        waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
      };
      await expect(
        events.waterfall(
          'agent/request',
          {
            agent: { id: h.session.id, options: {}, session: h.session, inbox: [], status: 'idle' },
            turn: 1,
            step: 1,
            signal: new AbortController().signal,
          },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ).rejects.toMatchObject({ code: 'AUDIT_PERSIST_FAILED' });
      expect(h.adapter.calls.length).toBe(0);
      // 还原故障：正常路径 Provider 恰好调用 1 次，决策 committed。
      h.setSinkFault(false);
      const config = await runAttempt(h, 2, 1);
      expect(config.provider).toBe('fake-provider');
      expect(h.adapter.calls.length).toBe(1);
      // 双写协议语义：第一次失败的请求在 SQLite 留下 pending 决策
      // （insert 成功、append 失败、CAS 未执行）——对账应补齐 committed。
      const beforeReconcile = await h.governor.listDecisions();
      const pendingCount = beforeReconcile.items.filter((d) => d.auditState === 'pending').length;
      expect(pendingCount).toBe(1);
      const reconcile = await h.governor.reconcileAudit();
      expect(reconcile.committed).toBe(1);
      expect(reconcile.pending).toBe(0);
      const list = await h.governor.listDecisions();
      expect(list.items).toHaveLength(2);
      expect(list.items.every((d) => d.auditState === 'committed')).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('正常路径：Provider 恰好 1 次调用，决策 committed，attempt 收敛 completed', async () => {
    const h = await bootFaultHarness();
    try {
      const config = await runAttempt(h, 1, 1);
      expect(config.provider).toBe('fake-provider');
      expect(h.adapter.calls.length).toBe(1);
      const list = await h.governor.listDecisions();
      expect(list.items).toHaveLength(1);
      expect(list.items[0]!.auditState).toBe('committed');
      expect(list.items[0]!.trigger).toBe('initial');
      expect(h.governor.getAttemptState(h.session.id, 1, 1)).toBe('completed');
    } finally {
      await h.dispose();
    }
  });
});

describe('GOV-ATTEMPT-001 attempt 生命周期', () => {
  it('request 后为 not_dispatched，llm/stream 边界前记录 dispatch_started，结束收敛 completed', async () => {
    const h = await bootFaultHarness();
    try {
      const events = h.ctx.events as unknown as {
        waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
      };
      await events.waterfall(
        'agent/request',
        {
          agent: { id: h.session.id, options: {}, session: h.session, inbox: [], status: 'idle' },
          turn: 2,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      // 决策已提交但未发生 dispatch：状态 not_dispatched（“已选择，未执行”）。
      expect(h.governor.getAttemptState(h.session.id, 2, 1)).toBe('not_dispatched');
      // dispatch 边界前进入 dispatch_started
      const config = { provider: 'fake-provider', model: 'model-a', messages: [], sessionId: h.session.id };
      const stream = (await events.waterfall('llm/stream', config, () =>
        (h.ctx.llm as unknown as { stream: (o: unknown) => AsyncIterable<unknown> }).stream(config),
      )) as AsyncIterable<unknown>;
      for await (const _ of stream) void _;
      expect(h.governor.getAttemptState(h.session.id, 2, 1)).toBe('completed');
    } finally {
      await h.dispose();
    }
  });
});

describe('GOV-TRACE-001 启动对账（reconcile）与状态清理', () => {
  it('手动制造的 pending 决策被对账补齐 committed（重复对账幂等）', async () => {
    const h = await bootFaultHarness();
    try {
      // 直接插入 pending 决策（模拟崩溃后遗留：SQLite 已写但未 CAS committed）
      await runAttempt(h, 1, 1);
      const pendingDecision = sealDecision({
        requestId: 'orphan-req',
        turn: 9,
        step: 9,
        fallbackIndex: 0,
        causes: ['step'],
        changedFields: [],
        selectionMode: 'manual',
        effectiveStrategy: 'manual',
        candidates: [{ routeId: 'fake-provider:model-a', quality: 90, multiplierPpm: 1_000_000 }],
        excluded: [],
        outcome: 'selected',
        selectedRoute: 'fake-provider:model-a',
        configRevision: h.governor.configRevision,
      });
      h.repo.insertSealedDecision(pendingDecision, { sessionId: h.session.id });
      expect(h.repo.getDecisions('orphan-req')[0]!.auditState).toBe('pending');
      // 对账：补齐 committed
      const result = await h.governor.reconcileAudit();
      expect(result.committed).toBe(1);
      expect(result.pending).toBe(0);
      expect(h.repo.getDecisions('orphan-req')[0]!.auditState).toBe('committed');
      // 重复对账幂等（无 pending 可处理）
      const again = await h.governor.reconcileAudit();
      expect(again.committed).toBe(0);
      expect(again.pending).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it('step/end 清理 request state（幂等），已提交 Decision/Usage 不被删除', async () => {
    const h = await bootFaultHarness();
    try {
      await runAttempt(h, 1, 1);
      expect((await h.governor.listDecisions()).items).toHaveLength(1);
      // step/end 清理 + 重复通知幂等
      h.governor.handleStepEnd(h.session.id, 1, 1);
      h.governor.handleStepEnd(h.session.id, 1, 1);
      // turn/end 与 session dispose 兜底
      h.governor.handleTurnEnd(h.session.id, 1);
      h.governor.handleSessionDispose(h.session.id);
      // 已提交记录仍在
      expect((await h.governor.listDecisions()).items).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  });
});
