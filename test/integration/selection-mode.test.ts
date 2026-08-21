/**
 * 任务3 集成测试：GOV-SELECT-001 会话选择模式（Auto/Manual 持久状态）。
 *
 * 覆盖：默认模式、切换与 selectionRevision、SELECTION_REVISION_CONFLICT、
 * 下一 attempt 的 selection_mode_change cause、模式对路由的影响（Auto/Manual）、
 * restore 恢复、fork 继承（通过事件流）、dispose 清理。
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
import { GovernorService } from '../../src/plugin/service.js';
import type { GovernorPluginConfig } from '../../src/plugin/service.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';
import {
  appendGovernorSelectionMode,
  GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
} from '../../src/dsh-adapter/session-events.js';
import SessionStore from '@deepseek-ai/dsh-session';

const providers = ['fake-provider'];
const models: LlmModelInfo[] = [
  { provider: 'fake-provider', id: 'model-a', name: 'Model A' },
  { provider: 'fake-provider', id: 'model-b', name: 'Model B' },
];

/** 全局默认 manual；会话可显式切 auto。 */
function config(): GovernorPluginConfig {
  return {
    identity: { provider: 'local', local_user_id: 'local' },
    routing: { default: 'manual' },
    auto: { confidence_threshold: 0.5 },
    models: {
      'fake-provider:model-a': { quality: { coding: 90, general: 90 }, multiplier: 1 },
      'fake-provider:model-b': { quality: { coding: 70, general: 60 }, multiplier: 0.5 },
    },
  } as GovernorPluginConfig;
}

/** 启动带 SQLite 的 service。 */
async function boot(): Promise<{ service: GovernorService; dispose: () => void }> {
  const ctx = new Context();
  const llm = ctx.plugin(LlmRuntime);
  await llm;
  const adapter = new FakeLlmAdapter(
    providers,
    models,
    successScript('ok', { inputTokens: 1, outputTokens: 1 }),
  );
  const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
  const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-select-'));
  const db = new GovernorDatabase(join(dbDir, 'governor.db'));
  const repo = new GovernorRepository(db);
  const service = new GovernorService(ctx, config(), repo, {});
  await service.refreshModelDirectory(
    () => ctx.llm.listProviders(),
    (p) => ctx.llm.listModels(p),
  );
  return {
    service,
    dispose: () => {
      db.close();
      disposeAdapter();
      void llm.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

describe('GOV-SELECT-001 会话选择模式', () => {
  it('默认使用全局默认（manual），切换后状态生效且 revision 递增', async () => {
    const h = await boot();
    try {
      expect(h.service.getSessionSelectionMode('s1').mode).toBe('manual');
      expect(h.service.getSessionSelectionMode('s1').isDefault).toBe(true);
      const r1 = await h.service.setSessionSelectionMode('s1', 'auto');
      expect(r1.selectionRevision).toBe(1);
      expect(h.service.getSessionSelectionMode('s1').mode).toBe('auto');
      expect(h.service.getSessionSelectionMode('s1').isDefault).toBe(false);
      const r2 = await h.service.setSessionSelectionMode('s1', 'manual', {
        lastManualRoute: 'fake-provider:model-a',
      });
      expect(r2.selectionRevision).toBe(2);
      expect(h.service.getSessionSelectionMode('s1').lastManualRoute).toBe('fake-provider:model-a');
    } finally {
      h.dispose();
    }
  });

  it('多标签页并发切换：expected revision 不匹配抛 SELECTION_REVISION_CONFLICT', async () => {
    const h = await boot();
    try {
      await h.service.setSessionSelectionMode('s1', 'auto'); // revision 0 → 1
      // 第二个标签页持有过期 revision 0
      await expect(
        h.service.setSessionSelectionMode('s1', 'manual', { expectedRevision: 0 }),
      ).rejects.toMatchObject({ code: 'SELECTION_REVISION_CONFLICT' });
      // 匹配的写入成功
      await expect(
        h.service.setSessionSelectionMode('s1', 'manual', { expectedRevision: 1 }),
      ).resolves.toMatchObject({ selectionRevision: 2 });
    } finally {
      h.dispose();
    }
  });

  it('切换只影响下一个 attempt：下一决策携带 selection_mode_change cause', async () => {
    const h = await boot();
    try {
      // manual 默认下的首个 attempt（initial cause）
      const first = await h.service.selectModel('s1', 1, 1, {
        provider: 'fake-provider',
        model: 'model-a',
      });
      expect(first.config.model).toBe('model-a');
      // 切换到 auto：下一 attempt 用 auto 路由 + selection_mode_change cause
      await h.service.setSessionSelectionMode('s1', 'auto');
      const second = await h.service.selectModel('s1', 1, 2, {
        provider: 'fake-provider',
        model: 'model-a',
      });
      const list = await h.service.listDecisions();
      const modeChange = list.items.find((d) => d.causes?.includes('selection_mode_change'));
      expect(modeChange).toBeDefined();
      expect(modeChange!.trigger).toBe('selection_mode_change');
      expect(modeChange!.selectionMode).toBe('auto');
      // Auto 路由对每个 step 重新决策（未分类回退 quality_first 策略）
      expect(second.config.provider).toBe('fake-provider');
    } finally {
      h.dispose();
    }
  });

  it('restore：从 selection-mode 事件流恢复模式（刷新/重启不丢失）', async () => {
    const h = await boot();
    try {
      // 模拟持久化：事件流中已有 revision 2 的 manual 状态（切过 auto 再切回）
      const events = [
        {
          type: 'governor/selection-mode',
          data: {
            schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
            selectionRevision: 1,
            mode: 'auto' as const,
            changedAt: 1,
          },
        },
        {
          type: 'governor/selection-mode',
          data: {
            schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
            selectionRevision: 2,
            mode: 'manual' as const,
            lastManualRoute: 'fake-provider:model-a',
            changedAt: 2,
          },
        },
      ];
      h.service.restoreSessionSelection('restored-1', events);
      const state = h.service.getSessionSelectionMode('restored-1');
      expect(state.mode).toBe('manual');
      expect(state.lastManualRoute).toBe('fake-provider:model-a');
      expect(state.selectionRevision).toBe(2);
      // 旧会话无事件 → isDefault（全局默认，不从 Decision 反推）
      expect(h.service.getSessionSelectionMode('legacy').isDefault).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('fork 继承：子会话从父事件前缀恢复相同模式', async () => {
    const ctx = new Context();
    const store = ctx.plugin(SessionStore);
    await store;
    try {
      const parent = ctx.sessions.create('parent-1', { meta: { cwd: process.cwd() } });
      appendGovernorSelectionMode(parent, {
        schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
        selectionRevision: 1,
        mode: 'auto',
        changedAt: Date.now(),
      });
      const child = ctx.sessions.fork(parent, undefined, 'child-1');
      expect(child.events.some((e) => e.type === 'governor/selection-mode')).toBe(true);
    } finally {
      await store.dispose();
    }
  });

  it('dispose 清理会话选择状态', async () => {
    const h = await boot();
    try {
      await h.service.setSessionSelectionMode('s1', 'auto');
      h.service.handleSessionDispose('s1');
      expect(h.service.getSessionSelectionMode('s1').isDefault).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('切回 Auto 时保留 lastManualRoute（便于切回但不约束 Auto 结果）', async () => {
    const h = await boot();
    try {
      await h.service.setSessionSelectionMode('s1', 'manual', {
        lastManualRoute: 'fake-provider:model-a',
      });
      // 切到 Auto：lastManualRoute 保留
      await h.service.setSessionSelectionMode('s1', 'auto');
      const state = h.service.getSessionSelectionMode('s1');
      expect(state.mode).toBe('auto');
      expect(state.lastManualRoute).toBe('fake-provider:model-a');
      // 再切回 Manual（未提供新 route）：沿用保留值
      await h.service.setSessionSelectionMode('s1', 'manual');
      expect(h.service.getSessionSelectionMode('s1').lastManualRoute).toBe('fake-provider:model-a');
    } finally {
      h.dispose();
    }
  });

  it('Auto 模式每个 step 重新决策（不锁定上一步模型）', async () => {
    const h = await boot();
    try {
      await h.service.setSessionSelectionMode('s2', 'auto');
      // 连续两个 step 都重新走 selectModel（各自产生独立决策）
      await h.service.selectModel('s2', 1, 1, { provider: 'fake-provider', model: 'model-a' });
      await h.service.selectModel('s2', 1, 2, { provider: 'fake-provider', model: 'model-a' });
      const list = await h.service.listDecisions();
      const s2Decisions = list.items.filter((d) => d.sessionId === 's2');
      expect(s2Decisions).toHaveLength(2);
      expect(s2Decisions.every((d) => d.selectionMode === 'auto')).toBe(true);
    } finally {
      h.dispose();
    }
  });
});
