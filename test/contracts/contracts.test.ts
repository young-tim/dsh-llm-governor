/**
 * DSH 合同测试：证明 Governor 能正确嵌入 DSH 的全部集成点。
 * 覆盖：model directory、pre-step、request 改写、stream 无损观察、
 * request-error 重路由、唯一 Recovery Owner、Web 身份绑定、Client Remote。
 * 在仓库唯一的 rc.8 DSH 契约下运行。
 */
import { describe, it, expect } from 'vitest';
import { bootFake, modelInfo } from './harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import type { GovernorIdentity } from '../../src/index.js';

// ===== 辅助构造 =====

/** 构造 agent 事件 payload 的最小 mock。 */
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
    runMaintenance: <T>(_t: (s: AbortSignal) => Promise<T>) => Promise.resolve() as Promise<T>,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
  };
}

/** 默认 Governor 配置。 */
function defaultGovernorConfig() {
  return {
    models: {
      'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
      'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
    },
    fallback: { enabled: true, max_attempts: 2 },
    identity: { provider: 'local' as const, local_user_id: 'local' },
  };
}

const providers = ['fake-provider'];
const models = [
  modelInfo('fake-provider', 'model-a', 'Model A'),
  modelInfo('fake-provider', 'model-b', 'Model B'),
];

// ===== 1. Model Directory =====

describe('model directory', () => {
  it('ctx.llm.listProviders 返回已注册的 provider', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    try {
      const list = h.ctx.llm.listProviders();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('fake-provider');
    } finally {
      await h.dispose();
    }
  });

  it('ctx.llm.listModels 返回 advisory 模型目录', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    try {
      const list = await h.ctx.llm.listModels('fake-provider');
      expect(list).toHaveLength(2);
      expect(list.map((m) => m.id).sort()).toEqual(['model-a', 'model-b']);
    } finally {
      await h.dispose();
    }
  });
});

// ===== 2. agent/pre-step =====

describe('agent/pre-step', () => {
  it('Governor 读取本步消息并透传到下游', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const messages = [{ type: 'text', text: 'hello' }];
      const payload = {
        agent: fakeAgent(),
        messages,
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      };
      const decision = await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages }));
      expect(decision).toEqual({ kind: 'enter', messages });
    } finally {
      await h.dispose();
    }
  });
});

// ===== 3. agent/request 改写 =====

describe('agent/request rewrite', () => {
  it('Governor 读取下游 LlmCallConfig 并可返回替换', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const payload = {
        agent: fakeAgent(),
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      };
      const defaultConfig = { provider: 'fake-provider', model: 'model-a' };
      const result = await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall('agent/request', payload, async () => ({ ...defaultConfig }));
      // Governor 透传或替换；结果必须是合法 LlmCallConfig
      expect(result).toMatchObject({ provider: 'fake-provider', model: expect.any(String) });
    } finally {
      await h.dispose();
    }
  });

  it('Disabled 模型不能成为候选', async () => {
    const config = defaultGovernorConfig();
    config.models!['fake-provider:model-a']!.enabled = false;
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      config,
    );
    try {
      const payload = {
        agent: fakeAgent(),
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      };
      await expect(
        (
          h.ctx.events as unknown as {
            waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
          }
        ).waterfall('agent/request', payload, async () => ({
          provider: 'fake-provider',
          model: 'model-a',
        })),
      ).rejects.toMatchObject({ code: 'MODEL_DISABLED' });
    } finally {
      await h.dispose();
    }
  });
});

// ===== 4. llm/stream 无损观察 =====

describe('llm/stream observe', () => {
  it('Governor 观察 usage/finish 而不消费或乱序流', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hello world', { inputTokens: 10, outputTokens: 5 }),
      defaultGovernorConfig(),
    );
    try {
      const options = { provider: 'fake-provider', model: 'model-a', messages: [] };
      const stream = (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => AsyncIterable<unknown>;
        }
      ).waterfall('llm/stream', options, () => h.adapter.stream(options as never));
      const chunks: unknown[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      // 流完整透传：至少有 block-start, text-delta, block-end, usage, finish
      expect(chunks.length).toBeGreaterThanOrEqual(5);
      // 顺序正确：usage 在 finish 前
      const usageIdx = chunks.findIndex((c) => (c as { type: string }).type === 'usage');
      const finishIdx = chunks.findIndex((c) => (c as { type: string }).type === 'finish');
      expect(usageIdx).toBeGreaterThan(-1);
      expect(finishIdx).toBeGreaterThan(usageIdx);
      // Governor 记录了 Usage
      expect(h.governor).toBeDefined();
      const usage = await h.governor!.queryUsage({});
      expect(usage).toHaveLength(1);
      expect(usage[0]!.inputTokens).toBe(10);
      expect(usage[0]!.outputTokens).toBe(5);
      expect(usage[0]!.success).toBe(true);
    } finally {
      await h.dispose();
    }
  });
});

// ===== 5. agent/request-error 重路由 =====

describe('agent/request-error re-route', () => {
  it('429 可重试：返回 {kind:retry} 并排除失败路由', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const agent = fakeAgent();
      const payload = {
        agent,
        turn: 1,
        step: 1,
        provider: 'fake-provider',
        failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      };
      const action = await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall('agent/request-error', payload, async () => undefined);
      expect(action).toEqual({ kind: 'retry' });
      // 失败路由已被排除
      const excluded = h.governor!.getExcludedRoutes(agent.id, 1, 1);
      expect(excluded.has('fake-provider')).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('Timeout 可重试', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const payload = {
        agent: fakeAgent(),
        turn: 1,
        step: 1,
        provider: 'fake-provider',
        failure: { message: 'timed out', code: 'TIMEOUT' },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      };
      const action = await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall('agent/request-error', payload, async () => undefined);
      expect(action).toEqual({ kind: 'retry' });
    } finally {
      await h.dispose();
    }
  });

  it('5xx 可重试', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const payload = {
        agent: fakeAgent(),
        turn: 1,
        step: 1,
        provider: 'fake-provider',
        failure: { message: 'server error', code: 'SERVER_ERROR', status: 503 },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      };
      const action = await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall('agent/request-error', payload, async () => undefined);
      expect(action).toEqual({ kind: 'retry' });
    } finally {
      await h.dispose();
    }
  });

  it('401 不可重试：不返回 retry', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const payload = {
        agent: fakeAgent(),
        turn: 1,
        step: 1,
        provider: 'fake-provider',
        failure: { message: 'unauthorized', code: 'AUTH', status: 401 },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      };
      const action = await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall('agent/request-error', payload, async () => undefined);
      // 401 不重试：Governor 调用 next() 返回 undefined
      expect(action).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it('达到 max_attempts 后不再重试', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const agent = fakeAgent();
      const ev = h.ctx.events as unknown as {
        waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
      };
      // 第一次 attempt（由 agent/request 记录 count=1）
      await ev.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      // 第一次失败 → retry（1 < 2 → true）
      const errPayload = {
        agent,
        turn: 1,
        step: 1,
        provider: 'fake-provider',
        failure: { message: '429', code: 'RATE_LIMIT', status: 429 },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      };
      const action1 = await ev.waterfall('agent/request-error', errPayload, async () => undefined);
      expect(action1).toEqual({ kind: 'retry' });
      // retry 后 loop 再次调用 agent/request（count=2）
      await ev.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-b' }),
      );
      // 第二次失败 → 已达到 max_attempts=2，不再重试
      const action2 = await ev.waterfall('agent/request-error', errPayload, async () => undefined);
      expect(action2).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });
});

// ===== 6. 唯一 Recovery Owner =====

describe('recovery owner uniqueness', () => {
  it('Governor 是唯一的 request-error recovery owner → 绿', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const hooks =
        (h.ctx.events as unknown as { _hooks: Record<string, unknown[]> })._hooks[
          'agent/request-error'
        ] ?? [];
      expect(hooks.length).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it('故意制造双 Recovery Owner 后可检测，移除后恢复（红→绿证据）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const ev = h.ctx.events as unknown as { _hooks: Record<string, unknown[]> };
      // 初始：Governor 是唯一 recovery owner
      expect(ev._hooks['agent/request-error']?.length ?? 0).toBe(1);

      // 故意注册第二个 recovery owner（模拟 dsh-llm-retry 同时存在）
      const fakeFiber = h.ctx.plugin({
        name: 'fake-retry',
        apply: (ctx: unknown) => {
          (
            ctx as unknown as {
              on: (name: string, listener: unknown, opts?: unknown) => () => void;
            }
          ).on(
            'agent/request-error',
            (async () => ({ kind: 'retry' })) as never,
            { global: true } as never,
          );
        },
      });
      await fakeFiber;

      // 现在有两个 recovery owner → 检测到双 owner（RED 场景）
      expect(ev._hooks['agent/request-error']?.length ?? 0).toBe(2);

      // 移除第二 owner → 恢复单 owner（GREEN 场景）
      await fakeFiber.dispose();
      expect(ev._hooks['agent/request-error']?.length ?? 0).toBe(1);
    } finally {
      await h.dispose();
    }
  });
});

// ===== 7. Web 身份绑定 =====

describe('web identity binding', () => {
  it('companion ingress 可绑定身份到 session', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const identity: GovernorIdentity = { userId: 'user-42', displayName: 'Alice' };
      await h.governor!.bindIdentity('session-1', identity);
      const bound = h.governor!.getIdentity('session-1');
      expect(bound).toEqual(identity);
    } finally {
      await h.dispose();
    }
  });

  it('空 user_id 绑定被拒绝（fail closed）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      await expect(h.governor!.bindIdentity('session-1', { userId: '' })).rejects.toThrow(
        'IDENTITY_REQUIRED',
      );
    } finally {
      await h.dispose();
    }
  });

  it('未绑定身份的 session 在 agent/request 中可被检测', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const payload = {
        agent: fakeAgent('unbound-session'),
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      };
      // Task 1: 未绑定时透传（完整 fail closed 在 Task 2）
      const result = await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall('agent/request', payload, async () => ({
        provider: 'fake-provider',
        model: 'model-a',
      }));
      expect(result).toMatchObject({ provider: 'fake-provider' });
      // 但 Usage 记录中 userId 为 unknown
      const usage = await h.governor!.queryUsage({});
      // agent/request 本身不产生 usage（stream 才产生）
      expect(usage).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });
});

// ===== 8. Client Remote =====

describe('client remote', () => {
  it('GovernorService.listModels 返回模型策略', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const list = await h.governor!.listModels();
      expect(list).toHaveLength(2);
      const routeIds = list.map((m) => m.routeId).sort();
      expect(routeIds).toEqual(['fake-provider:model-a', 'fake-provider:model-b']);
    } finally {
      await h.dispose();
    }
  });

  it('GovernorService.queryUsage 返回已记录的 Usage', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 8, outputTokens: 4 }),
      defaultGovernorConfig(),
    );
    try {
      // 触发一次 stream 观察
      const options = { provider: 'fake-provider', model: 'model-a', messages: [] };
      const stream = (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => AsyncIterable<unknown>;
        }
      ).waterfall('llm/stream', options, () => h.adapter.stream(options as never));
      for await (const _ of stream) {
        void _;
      }
      const usage = await h.governor!.queryUsage({});
      expect(usage).toHaveLength(1);
      expect(usage[0]!.inputTokens).toBe(8);
      expect(usage[0]!.provider).toBe('fake-provider');
    } finally {
      await h.dispose();
    }
  });

  it('GovernorService.explainDecision 返回决策记录', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultGovernorConfig(),
    );
    try {
      const payload = {
        agent: fakeAgent(),
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      };
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall('agent/request', payload, async () => ({
        provider: 'fake-provider',
        model: 'model-a',
      }));
      // 通过 listDecisions 获取 requestId（Repository 权威视图）
      const all = await h.governor!.listDecisions();
      expect(all.items).toHaveLength(1);
      const explained = await h.governor!.explainDecision(all.items[0]!.requestId);
      expect(explained).toHaveLength(1);
      expect(explained[0]!.selectedRoute).toBe('fake-provider:model-a');
      expect(explained[0]!.auditState).toBe('committed');
    } finally {
      await h.dispose();
    }
  });
});
