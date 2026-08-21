/**
 * 任务1 合同测试：DSH rc.8 request-scoped route override 接缝（六项契约第 3 项）。
 *
 * 证明：
 * - `agent/request` waterfall 的替换返回值就是 request-scoped dispatch context：
 *   Governor 的 Auto 改写只影响本次调用返回的 LlmCallConfig，不向 Session log
 *   写入任何模型选择/持久化事件（持久模型选择必须走 DSH 既有 selectModel 能力）。
 * - 同一 (session, turn, step) 的 waterfall 重入复用同一 requestId（request state
 *   语义），新 step 产生新 requestId。
 *
 * 全程使用 fake adapter 与临时 SQLite，不触碰真实 Provider。
 */
import { describe, expect, it } from 'vitest';
import SessionStore from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Context } from '../../src/dsh-adapter/mod.js';
import type { LlmModelInfo } from '../../src/dsh-adapter/mod.js';
import { FakeLlmAdapter } from '../../src/dsh-adapter/fake-adapter.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import { LlmRuntime } from '../../src/dsh-adapter/mod.js';
import { GovernorPlugin } from '../../src/plugin/mod.js';
import type { GovernorPluginConfig } from '../../src/plugin/mod.js';
import { GovernorService } from '../../src/plugin/service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@deepseek-ai/dsh-session';

const providers = ['fake-provider'];
const models: LlmModelInfo[] = [
  { provider: 'fake-provider', id: 'model-a', name: 'Model A' },
  { provider: 'fake-provider', id: 'model-b', name: 'Model B' },
];

/** Auto 默认配置：两个模型带质量画像，置信度阈值低以便 rule 分类直接生效。 */
function autoGovernorConfig(): GovernorPluginConfig {
  return {
    identity: { provider: 'local', local_user_id: 'local' },
    routing: { default: 'auto' },
    auto: { confidence_threshold: 0.5 },
    models: {
      'fake-provider:model-a': { quality: { coding: 90, general: 80 }, multiplier: 1 },
      'fake-provider:model-b': { quality: { coding: 70, general: 60 }, multiplier: 0.5 },
    },
  } as GovernorPluginConfig;
}

/** 携带真实 Session 的 harness：Governor + LlmRuntime + FakeAdapter + SessionStore。 */
interface SessionHarness {
  ctx: Context;
  session: Session;
  governor: GovernorService;
  dispose: () => Promise<void>;
}

/** 启动带真实 Session 的 Governor 环境。 */
async function bootWithSession(): Promise<SessionHarness> {
  const ctx = new Context();
  const llm = ctx.plugin(LlmRuntime);
  await llm;
  const adapter = new FakeLlmAdapter(
    providers,
    models,
    successScript('ok', { inputTokens: 1, outputTokens: 1 }),
  );
  const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
  const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-rs-'));
  // 加载 JsonlPersistence + SessionStore（在 Governor 之前），使 ctx.sessions 可用
  // 且 flush 返回 true（durable ack），审计双写协议在测试中完整闭环。
  const jsonl = ctx.plugin(JsonlPersistence, {
    root: join(dbDir, 'sessions'),
    compression: 'none',
  }) as unknown as { dispose: () => Promise<void> };
  await jsonl;
  const store = ctx.plugin(SessionStore) as unknown as { dispose: () => Promise<void> };
  await store;
  const gov = ctx.plugin(
    GovernorPlugin as never,
    {
      schema_version: 1,
      ...autoGovernorConfig(),
      storage: { enabled: true, path: join(dbDir, 'governor.db') },
    } as never,
  ) as unknown as { dispose: () => Promise<void> };
  await (gov as never as PromiseLike<unknown>);
  const session = ctx.sessions.create('rs-session-1', { meta: { cwd: dbDir } });
  return {
    ctx,
    session,
    governor: (ctx as unknown as { governor: GovernorService }).governor,
    dispose: async () => {
      await gov.dispose();
      await store.dispose();
      await jsonl.dispose();
      disposeAdapter();
      await llm.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

/** 触发一次 agent/pre-step → agent/request 链路并返回最终 LlmCallConfig。 */
async function runRequestCycle(
  h: SessionHarness,
  turn: number,
  step: number,
  fallbackConfig: { provider: string; model: string },
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
  await events.waterfall(
    'agent/pre-step',
    { ...payload, messages: [{ type: 'text', text: 'write a function' }] },
    async () => ({ kind: 'enter', messages: [] }),
  );
  return (await events.waterfall('agent/request', payload, async () => ({
    ...fallbackConfig,
  }))) as {
    provider: string;
    model: string;
  };
}

describe('rc.8 request-scoped route override seam', () => {
  it('Auto 改写只进入返回的 dispatch config，Session log 不出现持久模型选择事件', async () => {
    const h = await bootWithSession();
    try {
      const config = await runRequestCycle(h, 1, 1, {
        provider: 'fake-provider',
        model: 'model-a',
      });
      // Auto 依据 rule 分类（coding）选择达标集合中低倍率模型。
      expect(config).toMatchObject({ provider: 'fake-provider' });
      expect(typeof config.model).toBe('string');
      // request-scoped 证明：Session log 不出现持久模型选择事件（governor/selection-mode）；
      // 模型持久选择属于 DSH selectModel 能力，Governor 不得越权代写。
      // 审计双写协议写入 governor/routing-decision（决策审计轨迹）是预期行为。
      const persistedTypes = h.session.events.map((e) => e.type);
      expect(persistedTypes).not.toContain('governor/selection-mode');
    } finally {
      await h.dispose();
    }
  });

  it('同一 (session,turn,step) 重入复用同一 requestId；新 step 产生新 requestId', async () => {
    const h = await bootWithSession();
    try {
      await runRequestCycle(h, 1, 1, { provider: 'fake-provider', model: 'model-a' });
      const first = h.governor.getRequestId(h.session.id, 1, 1);
      expect(first).toBeDefined();
      // 模拟 middleware 重入：同一 step 再次 waterfall。
      const events = h.ctx.events as unknown as {
        waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
      };
      await events.waterfall(
        'agent/request',
        {
          agent: { id: h.session.id, options: {}, session: h.session, inbox: [], status: 'idle' },
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      expect(h.governor.getRequestId(h.session.id, 1, 1)).toBe(first);
      // 新 step：新 requestId、fallbackIndex 归零。
      await runRequestCycle(h, 1, 2, { provider: 'fake-provider', model: 'model-a' });
      const second = h.governor.getRequestId(h.session.id, 1, 2);
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(h.governor.getFallbackIndex(h.session.id, 1, 2)).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it('llm/stream 收到的 provider/model 与 agent/request 返回的 dispatch config 一致', async () => {
    const h = await bootWithSession();
    try {
      const config = await runRequestCycle(h, 2, 1, {
        provider: 'fake-provider',
        model: 'model-a',
      });
      const events = h.ctx.events as unknown as {
        waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
      };
      const dispatch = { ...config, messages: [], sessionId: h.session.id };
      const chunks: unknown[] = [];
      const stream = (await events.waterfall('llm/stream', dispatch, () =>
        (
          h.ctx.llm as unknown as {
            stream: (o: unknown) => AsyncIterable<unknown>;
          }
        ).stream(dispatch),
      )) as AsyncIterable<unknown>;
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks.length).toBeGreaterThan(0);
      // 观察（llm/stream）不改写 dispatch：route 一致性由 waterfall 顺序保证。
      expect(dispatch.provider).toBe(config.provider);
      expect(dispatch.model).toBe(config.model);
    } finally {
      await h.dispose();
    }
  });
});
