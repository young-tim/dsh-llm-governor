/**
 * 任务1 合同测试：DSH rc.8 Session Event 接缝（六项契约中的第 1、2 项）。
 *
 * 证明/证伪：
 * - Session Event 幂等持久化：append/flush/fromRestore 存在；append 无幂等键参数，
 *   幂等由 Governor 持久层（扫描 log + append）实现。未知插件 envelope 的红灯证据
 *   保留；正式写入改用已知 `request/context` carrier 并通过真实 JSONL 冷恢复。
 * - 会话控制状态：selection 投影持久化于 log，fork/seed/冷启动后可重建。
 *
 * 全程使用临时目录与内存 Context，不触碰真实 DSH_HOME。
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { Session } from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { AuditPipeline, SessionStoreSink } from '../../src/plugin/audit-pipeline.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';
import {
  GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
  appendGovernorDecision,
  appendGovernorSelectionMode,
  findGovernorDecision,
  restoreGovernorSelection,
  type GovernorRoutingDecisionEventData,
} from '../../src/dsh-adapter/session-events.js';

/** 构造一条最小决策事件数据的 helper。 */
function decisionData(
  decisionId: string,
  overrides?: Partial<GovernorRoutingDecisionEventData>,
): GovernorRoutingDecisionEventData {
  const [requestId, fallbackIndex] = decisionId.split(':');
  return {
    schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
    decisionId,
    decisionHash: `hash-${decisionId}`,
    requestId,
    turn: 1,
    step: 1,
    fallbackIndex: Number(fallbackIndex),
    trigger: 'step',
    causes: ['step'],
    changedFields: [],
    selectionMode: 'auto',
    effectiveStrategy: 'credit_first',
    outcome: 'selected',
    configRevision: 1,
    occurredAt: Date.now(),
    ...overrides,
  };
}

/** 明文 JSONL 持久化测试的临时根目录。 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-gov-seam-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 启动一套带 JSONL 持久化后端的 Context（SessionStore + persistence）。 */
async function bootPersisted(
  rootDir: string,
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  const jsonl = ctx.plugin(JsonlPersistence, { root: rootDir, compression: 'none' });
  await jsonl;
  const store = ctx.plugin(SessionStore);
  await store;
  return {
    ctx,
    dispose: async () => {
      await store.dispose();
      await jsonl.dispose();
    },
  };
}

/** 在持久化目录中递归查找明文 session log 文件。 */
function findLog(dir: string): string {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      const found = findLog(p);
      if (found !== '') return found;
    } else if (ent.name.endsWith('.jsonl')) {
      return p;
    }
  }
  return '';
}

describe('rc.8 Session Event seam: append/幂等/durable ack', () => {
  it('append 接受 declaration-merged 的 governor 事件并分配连续 seq', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('seam-1', { meta: { cwd: root } });
    session.append('turn/start', { turn: 1 });
    const event = appendGovernorDecision(
      session,
      decisionData('req-1:0', { selectedRoute: 'fake-provider:model-a' }),
    );
    expect(event.type).toBe('request/context');
    expect(event.seq).toBe(1);
    expect(event.data.provider).toBe('fake-provider');
    expect(event.data.model).toBe('model-a');
    expect(event.data.governorDecision?.decisionId).toBe('req-1:0');
    // 事件 envelope 与 data 被 deepFreeze：持久 log 不可事后改写。
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
    await store.dispose();
  });

  it('同一 decisionId 重复 append 不产生第二条逻辑事件（持久层幂等）', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('seam-2', { meta: { cwd: root } });
    appendGovernorDecision(
      session,
      decisionData('req-2:0', { selectedRoute: 'fake-provider:model-a' }),
    );
    const before = session.events.length;
    const again = appendGovernorDecision(
      session,
      decisionData('req-2:0', { selectedRoute: 'fake-provider:model-a' }),
    );
    expect(session.events.length).toBe(before);
    expect(again.data.governorDecision?.decisionId).toBe('req-2:0');
    // 不同 fallbackIndex 属于新 attempt，正常追加。
    appendGovernorDecision(
      session,
      decisionData('req-2:1', { selectedRoute: 'fake-provider:model-a' }),
    );
    expect(session.events.length).toBe(before + 1);
    await store.dispose();
  });

  it('同 decisionId 但不同 hash 返回 DECISION_CONFLICT，不覆盖不静默', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('seam-3', { meta: { cwd: root } });
    appendGovernorDecision(
      session,
      decisionData('req-3:0', { selectedRoute: 'fake-provider:model-a' }),
    );
    expect(() =>
      appendGovernorDecision(
        session,
        decisionData('req-3:0', {
          decisionHash: 'different',
          selectedRoute: 'fake-provider:model-a',
        }),
      ),
    ).toThrowError(/DECISION_CONFLICT/);
    // 原事件未被覆盖。
    const found = findGovernorDecision(session, 'req-3:0');
    expect(found?.type).toBe('request/context');
    expect(found?.type === 'request/context' && found.data.governorDecision.decisionHash).toBe(
      'hash-req-3:0',
    );
    await store.dispose();
  });

  it('Session.append 的返回事件 envelope 不含 ignorable 字段且被冻结（SEAM-1 API 面证据）', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('seam-4', { meta: { cwd: root } });
    const event = session.append('governor/routing-decision', decisionData('req-4:0'));
    // rc.8 append 只构造 type/seq/time/data(/surface 元数据)，无 ignorable 通道。
    expect('ignorable' in event).toBe(false);
    expect(() => {
      (event as unknown as { ignorable?: true }).ignorable = true;
    }).toThrowError(TypeError);
    await store.dispose();
  });

  it('session/flush 是 durable acknowledgement 入口：有持久化监听时返回 true', async () => {
    const { ctx, dispose } = await bootPersisted(root);
    const session = ctx.sessions.create('seam-5', { meta: { cwd: root } });
    session.append('turn/start', { turn: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const participated = await ctx.sessions.flush(session);
    // SessionStore.flush 返回“是否有 durability listener 参与”，即 durable ack 信号。
    expect(participated).toBe(true);
    await dispose();
  });
});

describe('rc.8 Session Event seam: 持久化冷读回', () => {
  it('历史未标 ignorable 的 governor/* envelope 仍会被 rc.8 拒绝', async () => {
    const dir = mkdtempSync(join(root, 'refuse'));
    {
      const { ctx, dispose } = await bootPersisted(dir);
      const session = ctx.sessions.create('cold-1', { meta: { cwd: dir } });
      session.append('turn/start', { turn: 1 });
      session.append('step/start', { turn: 1, step: 1 });
      // 直接复现早期开发版 envelope；当前 appendGovernorDecision 已不再写该类型。
      session.append('governor/routing-decision', decisionData('req-c1:0'));
      session.append('step/end', { turn: 1, step: 1 });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await ctx.sessions.flush(session);
      await dispose();
    }
    {
      // 模拟进程重启：全新 Context 冷读回同一持久化目录。
      const { ctx, dispose } = await bootPersisted(dir);
      await expect(ctx.sessionPersistence.load('cold-1')).rejects.toThrowError(
        /unknown to this harness and not marked ignorable/,
      );
      await dispose();
    }
  });

  it('request/context 命名投影经真实 JSONL 持久化、关闭、重启后可冷读恢复', async () => {
    const dir = mkdtempSync(join(root, 'carrier-cold-read'));
    {
      const { ctx, dispose } = await bootPersisted(dir);
      const session = ctx.sessions.create('cold-2', { meta: { cwd: dir } });
      session.append('turn/start', { turn: 1 });
      session.append('step/start', { turn: 1, step: 1 });
      appendGovernorDecision(
        session,
        decisionData('req-c2:0', { selectedRoute: 'fake-provider:model-a' }),
      );
      session.append('step/end', { turn: 1, step: 1 });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await ctx.sessions.flush(session);
      await dispose();
    }
    // 物理 log 写入的是 rc.8 已知 envelope，不依赖 Governor 动态注册。
    const logPath = findLog(dir);
    expect(logPath).not.toBe('');
    const raw = readFileSync(logPath, 'utf8');
    expect(raw).toContain('"type":"request/context"');
    expect(raw).toContain('"governorDecision"');
    expect(raw).not.toContain('"type":"governor/routing-decision"');
    {
      // 全新 Context 模拟进程重启；只由 rc.8 persistence 解释 envelope。
      const { ctx, dispose } = await bootPersisted(dir);
      const loaded = await ctx.sessionPersistence.load('cold-2');
      const carrier = loaded.events.find(
        (event) =>
          event.type === 'request/context' &&
          event.data.governorDecision?.decisionId === 'req-c2:0',
      );
      expect(carrier?.type).toBe('request/context');
      if (carrier?.type === 'request/context') {
        expect(carrier.data.provider).toBe('fake-provider');
        expect(carrier.data.model).toBe('model-a');
        expect(carrier.data.governorDecision?.decisionHash).toBe('hash-req-c2:0');
      }
      await dispose();
    }
  });

  it('Session API 层（fromRestore/seed）不拒绝 governor 事件：内存与 fork 路径兼容', () => {
    const seed: never[] = [];
    const session = Session.create('seed-1', seed, {
      version: 0,
      id: 'seed-1',
      createdAt: Date.now(),
      cwd: root,
    });
    appendGovernorDecision(
      session,
      decisionData('req-s1:0', { selectedRoute: 'fake-provider:model-a' }),
    );
    // fromRestore 接受含 governor 事件的 seed（envelope 校验不检查 KNOWN 类型集）。
    const restored = Session.fromRestore('seed-1', structuredClone(session.events), {
      version: 0,
      id: 'seed-1',
      createdAt: Date.now(),
      cwd: root,
    });
    expect(
      restored.events.some(
        (e) => e.type === 'request/context' && e.data.governorDecision?.decisionId === 'req-s1:0',
      ),
    ).toBe(true);
  });
});

describe('rc.8 会话控制状态 seam: selection-mode 事件持久化与恢复', () => {
  it('全新空 Session 在首次决策前可用显式当前 route 持久切换', async () => {
    const dir = mkdtempSync(join(root, 'selection-empty-session'));
    const db = new GovernorDatabase(join(dir, 'governor.db'));
    const repository = new GovernorRepository(db);
    {
      const { ctx, dispose } = await bootPersisted(dir);
      const session = ctx.sessions.create('sel-empty', { meta: { cwd: dir } });
      expect(session.events).toHaveLength(0);
      const pipeline = new AuditPipeline(
        repository,
        new SessionStoreSink(
          (id) => ctx.sessions.get(id),
          (live) => ctx.sessions.flush(live),
          () => ctx.sessions.list(),
        ),
      );
      await pipeline.commitSelectionMode(
        session.id,
        {
          schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
          selectionRevision: 1,
          mode: 'auto',
          changedAt: Date.now(),
        },
        { provider: 'fake-provider', model: 'model-a' },
      );
      const carrier = session.events[0];
      expect(carrier?.type).toBe('request/context');
      if (carrier?.type === 'request/context') {
        expect(carrier.data).toMatchObject({
          provider: 'fake-provider',
          model: 'model-a',
          governorSelection: { selectionRevision: 1, mode: 'auto' },
        });
      }
      await dispose();
    }
    {
      const { ctx, dispose } = await bootPersisted(dir);
      const loaded = await ctx.sessionPersistence.load('sel-empty');
      expect(restoreGovernorSelection(loaded.events)?.mode).toBe('auto');
      await dispose();
    }
    db.close();
  });

  it('selection-mode 投影持久化后可跨进程冷恢复', async () => {
    const dir = mkdtempSync(join(root, 'selection-cold-read'));
    {
      const { ctx, dispose } = await bootPersisted(dir);
      const session = ctx.sessions.create('sel-cold', { meta: { cwd: dir } });
      appendGovernorSelectionMode(session, {
        schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
        selectionRevision: 1,
        mode: 'auto',
        lastManualRoute: 'fake-provider:model-a',
        changedAt: Date.now(),
      });
      await ctx.sessions.flush(session);
      await dispose();
    }
    {
      const { ctx, dispose } = await bootPersisted(dir);
      const loaded = await ctx.sessionPersistence.load('sel-cold');
      expect(restoreGovernorSelection(loaded.events)).toEqual({
        mode: 'auto',
        lastManualRoute: 'fake-provider:model-a',
        selectionRevision: 1,
      });
      await dispose();
    }
  });

  it('selection-mode 事件写入 log，幂等重放不重复', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const session = ctx.sessions.create('sel-1', { meta: { cwd: root } });
    appendGovernorSelectionMode(session, {
      schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
      selectionRevision: 1,
      mode: 'auto',
      lastManualRoute: 'fake-provider:model-a',
      changedAt: Date.now(),
    });
    const count = session.events.length;
    appendGovernorSelectionMode(session, {
      schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
      selectionRevision: 1,
      mode: 'auto',
      lastManualRoute: 'fake-provider:model-a',
      changedAt: Date.now() + 1,
    });
    expect(session.events.length).toBe(count);
    // 新 revision 正常追加并更新状态。
    appendGovernorSelectionMode(session, {
      schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
      selectionRevision: 2,
      mode: 'manual',
      lastManualRoute: 'fake-provider:model-a',
      changedAt: Date.now() + 2,
    });
    expect(session.events.length).toBe(count + 1);
    await store.dispose();
  });

  it('fork 继承事件前缀，restoreGovernorSelection 从种子事件重建模式', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    const parent = ctx.sessions.create('sel-2', { meta: { cwd: root } });
    appendGovernorSelectionMode(parent, {
      schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
      selectionRevision: 1,
      mode: 'auto',
      lastManualRoute: 'fake-provider:model-a',
      changedAt: Date.now(),
    });
    appendGovernorSelectionMode(parent, {
      schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
      selectionRevision: 2,
      mode: 'manual',
      lastManualRoute: 'fake-provider:model-b',
      lastDecisionConfigRevision: 3,
      changedAt: Date.now(),
    });
    const child = ctx.sessions.fork(parent, undefined, 'sel-2-child');
    // fork 继承 mode 与 lastManualRoute（事件前缀被复制）。
    const state = restoreGovernorSelection(child.events);
    expect(state).toEqual({
      mode: 'manual',
      lastManualRoute: 'fake-provider:model-b',
      selectionRevision: 2,
      lastDecisionConfigRevision: 3,
    });
    // seed 恢复路径（SessionStore.create with seed）同样重建。
    const resumed = ctx.sessions.create('sel-2-resume', {
      seed: [...child.events],
      meta: { cwd: root },
    });
    expect(restoreGovernorSelection(resumed.events)?.mode).toBe('manual');
    // 无 selection-mode 事件的旧会话返回 undefined（调用方用全局默认，不反推）。
    const legacy = ctx.sessions.create('sel-2-legacy', { meta: { cwd: root } });
    expect(restoreGovernorSelection(legacy.events)).toBeUndefined();
    await store.dispose();
  });
});
