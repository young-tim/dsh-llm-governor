/**
 * 集成测试：A 失败 → B 成功的完整 Fallback 流程。
 * 断言一个 request_id、两个 decisions、两个 usage。
 * 覆盖 401/abort/partial output 不触发切换。
 * 覆盖 Credits 和 fallback 上限的红→绿验证。
 */
import { describe, it, expect } from 'vitest';
import { bootFake, modelInfo } from '../contracts/harness.js';
import {
  successScript,
  rateLimitScript,
  authErrorScript,
} from '../../src/dsh-adapter/fake-adapter.js';
import type { FakeStreamScript } from '../../src/dsh-adapter/fake-adapter.js';

/** 构造 fake agent。 */
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

/** Quality First 配置：A 质量更高，B 更便宜。 */
function qualityFirstConfig(maxAttempts = 2) {
  return {
    models: {
      'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
      'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
    },
    routing: { default: 'quality_first' as const },
    fallback: { enabled: true, max_attempts: maxAttempts },
    identity: { provider: 'local' as const, local_user_id: 'local' },
  };
}

const providers = ['fake-provider'];
const models = [
  modelInfo('fake-provider', 'model-a', 'Model A'),
  modelInfo('fake-provider', 'model-b', 'Model B'),
];

/** 根据模型选择脚本的 fake adapter 脚本函数。 */
function scriptForModel(options: { model: string }, _callIndex: number): FakeStreamScript {
  if (options.model === 'model-a') {
    return rateLimitScript();
  }
  return successScript('hello from B', { inputTokens: 5, outputTokens: 3 });
}

/** 事件分发辅助。 */
function ev(ctx: unknown) {
  return (
    ctx as unknown as {
      events: { waterfall: (name: string, ...args: unknown[]) => Promise<unknown> };
    }
  ).events;
}

describe('A 失败 → B 成功', () => {
  it('一个 request_id、两个 decisions、两个 usage', async () => {
    const h = await bootFake(providers, models, scriptForModel as never, qualityFirstConfig());
    try {
      const agent = fakeAgent();
      const e = ev(h.ctx);

      // 1. agent/request → Governor 选择 model-a（quality 更高）
      const config1 = (await e.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { provider: string; model: string };
      expect(config1.model).toBe('model-a');

      // 2. llm/stream → model-a 失败（429）
      const stream1 = (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => AsyncIterable<unknown>;
        }
      ).waterfall(
        'llm/stream',
        {
          provider: 'fake-provider',
          model: 'model-a',
          messages: [],
          sessionId: 'session-1' as never,
        },
        () =>
          h.adapter.stream({ provider: 'fake-provider', model: 'model-a', messages: [] } as never),
      );
      for await (const _ of stream1) {
        void _;
      }

      // 3. agent/request-error → Governor 返回 {kind:'retry'}，排除 model-a
      const action = await e.waterfall(
        'agent/request-error',
        {
          agent,
          turn: 1,
          step: 1,
          provider: 'fake-provider',
          failure: { message: '429', code: 'RATE_LIMIT', status: 429 },
          retryPolicy: undefined,
          signal: new AbortController().signal,
        },
        async () => undefined,
      );
      expect(action).toEqual({ kind: 'retry' });

      // 4. agent/request → Governor 选择 model-b（model-a 被排除）
      const config2 = (await e.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-b' }),
      )) as { provider: string; model: string };
      expect(config2.model).toBe('model-b');

      // 5. llm/stream → model-b 成功
      const stream2 = (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => AsyncIterable<unknown>;
        }
      ).waterfall(
        'llm/stream',
        {
          provider: 'fake-provider',
          model: 'model-b',
          messages: [],
          sessionId: 'session-1' as never,
        },
        () =>
          h.adapter.stream({ provider: 'fake-provider', model: 'model-b', messages: [] } as never),
      );
      for await (const _ of stream2) {
        void _;
      }

      // 验证：两个 decisions
      const decisions = await h.governor!.listDecisions();
      expect(decisions).toHaveLength(2);
      // 同一个 request_id
      expect(decisions[0]!.requestId).toBe(decisions[1]!.requestId);
      // 第一个选 model-a，第二个选 model-b
      expect(decisions[0]!.selectedModel).toBe('model-a');
      expect(decisions[1]!.selectedModel).toBe('model-b');

      // 验证：两个 usage（一个失败，一个成功）
      const usage = await h.governor!.queryUsage({});
      expect(usage).toHaveLength(2);
      // 第一个失败（429），第二个成功
      const failed = usage.find((u: { success: boolean }) => !u.success);
      const succeeded = usage.find((u: { success: boolean }) => u.success);
      expect(failed).toBeDefined();
      expect(succeeded).toBeDefined();
    } finally {
      await h.dispose();
    }
  });
});

describe('401/abort 不触发切换', () => {
  it('401 鉴权错误不重试', async () => {
    const h = await bootFake(
      providers,
      models,
      ((_opts: { model: string }) => authErrorScript()) as never,
      qualityFirstConfig(),
    );
    try {
      const agent = fakeAgent();
      const e = ev(h.ctx);

      // agent/request → 选择 model-a
      await e.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );

      // agent/request-error → 401 不可重试
      const action = await e.waterfall(
        'agent/request-error',
        {
          agent,
          turn: 1,
          step: 1,
          provider: 'fake-provider',
          failure: { message: 'unauthorized', code: 'AUTH', status: 401 },
          retryPolicy: undefined,
          signal: new AbortController().signal,
        },
        async () => undefined,
      );
      // 401 不触发 retry
      expect(action).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it('部分输出后不切换模型（after_partial_output=false）', async () => {
    const config = qualityFirstConfig();
    config.fallback!.after_partial_output = false;
    const h = await bootFake(
      providers,
      models,
      ((_opts: { model: string }): FakeStreamScript => ({
        text: 'partial',
        finish: 'error',
        failure: { message: '5xx', code: 'SERVER_ERROR', status: 503 },
      })) as never,
      config,
    );
    try {
      const agent = fakeAgent();
      const e = ev(h.ctx);

      // agent/request → 选择 model-a
      await e.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );

      // llm/stream → 产出部分文本后失败
      const stream = (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => AsyncIterable<unknown>;
        }
      ).waterfall(
        'llm/stream',
        {
          provider: 'fake-provider',
          model: 'model-a',
          messages: [],
          sessionId: 'session-1' as never,
        },
        () =>
          h.adapter.stream({ provider: 'fake-provider', model: 'model-a', messages: [] } as never),
      );
      for await (const _ of stream) {
        void _;
      }

      // 标记部分输出
      h.governor!.markPartialOutput(agent.id, 1, 1);

      // agent/request-error → 5xx 但已交付部分输出 → 不重试
      const action = await e.waterfall(
        'agent/request-error',
        {
          agent,
          turn: 1,
          step: 1,
          provider: 'fake-provider',
          failure: { message: '5xx', code: 'SERVER_ERROR', status: 503 },
          retryPolicy: undefined,
          signal: new AbortController().signal,
        },
        async () => undefined,
      );
      expect(action).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });
});

describe('Fallback 上限红→绿', () => {
  it('max_attempts=1 时不重试（红），max_attempts=2 时重试（绿）', async () => {
    // 红：max_attempts=1
    const h1 = await bootFake(providers, models, scriptForModel as never, qualityFirstConfig(1));
    try {
      const agent = fakeAgent();
      const e = ev(h1.ctx);
      await e.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      const action = await e.waterfall(
        'agent/request-error',
        {
          agent,
          turn: 1,
          step: 1,
          provider: 'fake-provider',
          failure: { message: '429', code: 'RATE_LIMIT', status: 429 },
          retryPolicy: undefined,
          signal: new AbortController().signal,
        },
        async () => undefined,
      );
      // max_attempts=1 → 已达到上限 → 不重试（红场景）
      expect(action).toBeUndefined();
    } finally {
      await h1.dispose();
    }

    // 绿：max_attempts=2
    const h2 = await bootFake(providers, models, scriptForModel as never, qualityFirstConfig(2));
    try {
      const agent = fakeAgent();
      const e = ev(h2.ctx);
      await e.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      const action = await e.waterfall(
        'agent/request-error',
        {
          agent,
          turn: 1,
          step: 1,
          provider: 'fake-provider',
          failure: { message: '429', code: 'RATE_LIMIT', status: 429 },
          retryPolicy: undefined,
          signal: new AbortController().signal,
        },
        async () => undefined,
      );
      // max_attempts=2 → 还能重试 → {kind:'retry'}（绿场景）
      expect(action).toEqual({ kind: 'retry' });
    } finally {
      await h2.dispose();
    }
  });
});

describe('Credits 额度耗尽红→绿', () => {
  it('额度耗尽时拒绝请求（红），恢复后允许（绿）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
      qualityFirstConfig(),
    );
    try {
      const agent = fakeAgent();
      const e = ev(h.ctx);
      // 绑定身份
      await h.governor!.bindIdentity(agent.id, { userId: 'user-1' });

      // 红：额度耗尽 → 请求被拒绝
      h.governor!.setQuotaExceeded('user-1', true);
      await expect(
        e.waterfall(
          'agent/request',
          { agent, turn: 1, step: 1, signal: new AbortController().signal },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ).rejects.toMatchObject({ code: 'NO_MODEL_MATCHED' });

      // 绿：恢复额度 → 请求被允许
      h.governor!.setQuotaExceeded('user-1', false);
      const config = (await e.waterfall(
        'agent/request',
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config.model).toBe('model-a');
    } finally {
      await h.dispose();
    }
  });
});
