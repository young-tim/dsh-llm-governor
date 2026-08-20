/**
 * FakeLlmAdapter 单元测试：覆盖 setRetryPolicy、providerInfo、providerRetryPolicy、
 * listModels、resolveModel（命中/未命中）、stream、以及各脚本辅助函数。
 */
import { describe, it, expect } from 'vitest';
import {
  FakeLlmAdapter,
  successScript,
  rateLimitScript,
  serverErrorScript,
  timeoutScript,
  authErrorScript,
} from '../../src/dsh-adapter/fake-adapter.js';
import type { FakeStreamScript } from '../../src/dsh-adapter/fake-adapter.js';
import type { LlmModelInfo, ResolvedRetryPolicy } from '../../src/dsh-adapter/mod.js';

/** 构造模型信息。 */
function model(provider: string, id: string, name?: string): LlmModelInfo {
  return { provider, id, name: name ?? id };
}

const providers = ['fake-provider'];
const models = [
  model('fake-provider', 'model-a', 'Model A'),
  model('fake-provider', 'model-b', 'Model B'),
];

// ===== 基础方法 =====

describe('FakeLlmAdapter/providerInfo', () => {
  it('返回 provider id 和 name', () => {
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    const info = adapter.providerInfo('fake-provider');
    expect(info.id).toBe('fake-provider');
    expect(info.name).toBe('fake-provider');
  });
});

describe('FakeLlmAdapter/listModels', () => {
  it('返回已注册的模型列表', async () => {
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    const list = await adapter.listModels('fake-provider');
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.id).sort()).toEqual(['model-a', 'model-b']);
  });

  it('未注册的 provider 返回空数组', async () => {
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    const list = await adapter.listModels('unknown-provider');
    expect(list).toEqual([]);
  });
});

describe('FakeLlmAdapter/resolveModel', () => {
  it('已注册模型返回完整信息 + context', async () => {
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    const resolved = await adapter.resolveModel('fake-provider', 'model-a');
    expect(resolved.id).toBe('model-a');
    expect(resolved.name).toBe('Model A');
    expect(resolved.provider).toBe('fake-provider');
    expect(resolved.context).toBeDefined();
    expect(resolved.context.contextWindow).toBe(128_000);
  });

  it('未注册模型返回默认 contextWindow', async () => {
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    const resolved = await adapter.resolveModel('fake-provider', 'nonexistent');
    expect(resolved.id).toBe('nonexistent');
    expect(resolved.name).toBe('nonexistent');
    expect(resolved.context.contextWindow).toBe(128_000);
  });
});

describe('FakeLlmAdapter/setRetryPolicy + providerRetryPolicy', () => {
  it('setRetryPolicy 设置后 providerRetryPolicy 返回该策略', () => {
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    // 初始为 undefined
    expect(adapter.providerRetryPolicy('fake-provider')).toBeUndefined();
    // 设置策略
    const policy: ResolvedRetryPolicy = {
      kind: 'normal',
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
      jitter: false,
    } as ResolvedRetryPolicy;
    adapter.setRetryPolicy(policy);
    expect(adapter.providerRetryPolicy('fake-provider')).toBe(policy);
  });

  it('setRetryPolicy(undefined) 清除策略', () => {
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
    );
    const policy = { kind: 'always' } as ResolvedRetryPolicy;
    adapter.setRetryPolicy(policy);
    expect(adapter.providerRetryPolicy('fake-provider')).toBe(policy);
    adapter.setRetryPolicy(undefined);
    expect(adapter.providerRetryPolicy('fake-provider')).toBeUndefined();
  });
});

// ===== stream =====

describe('FakeLlmAdapter/stream', () => {
  it('成功脚本产出 text + usage + finish', async () => {
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('hello', { inputTokens: 10, outputTokens: 5 }),
    );
    const chunks: { type: string }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(chunk as { type: string });
    }
    // block-start, text-delta, block-end, usage, finish
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.some((c) => c.type === 'block-start')).toBe(true);
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(chunks.some((c) => c.type === 'block-end')).toBe(true);
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
    expect(chunks.some((c) => c.type === 'finish')).toBe(true);
    // calls 被记录
    expect(adapter.calls).toHaveLength(1);
  });

  it('空 text 不产出文本块', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      text: '',
      usage: { inputTokens: 1, outputTokens: 1 },
      finish: 'stop',
    });
    const chunks: { type: string }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(chunk as { type: string });
    }
    expect(chunks.some((c) => c.type === 'block-start')).toBe(false);
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
    expect(chunks.some((c) => c.type === 'finish')).toBe(true);
  });

  it('无 text 字段时不产出文本块', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      usage: { inputTokens: 1, outputTokens: 1 },
      finish: 'stop',
    });
    const chunks: { type: string }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(chunk as { type: string });
    }
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(false);
  });

  it('无 usage 字段时不产出 usage 块', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      text: 'hi',
      finish: 'stop',
    });
    const chunks: { type: string }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(chunk as { type: string });
    }
    expect(chunks.some((c) => c.type === 'usage')).toBe(false);
    expect(chunks.some((c) => c.type === 'finish')).toBe(true);
  });

  it('默认 finish=stop', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      text: 'hi',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const chunks: { type: string; reason?: { kind: string } }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(chunk as { type: string; reason?: { kind: string } });
    }
    const finish = chunks.find((c) => c.type === 'finish');
    expect(finish).toBeDefined();
    expect(finish!.reason!.kind).toBe('stop');
  });

  it('tool-calls finish', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      finish: 'tool-calls',
    });
    const chunks: { type: string; reason?: { kind: string } }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(chunk as { type: string; reason?: { kind: string } });
    }
    const finish = chunks.find((c) => c.type === 'finish');
    expect(finish!.reason!.kind).toBe('tool-calls');
  });

  it('max-tokens finish', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      finish: 'max-tokens',
    });
    const chunks: { type: string; reason?: { kind: string } }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(chunk as { type: string; reason?: { kind: string } });
    }
    const finish = chunks.find((c) => c.type === 'finish');
    expect(finish!.reason!.kind).toBe('max-tokens');
  });

  it('error finish 带 failure 信息', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      finish: 'error',
      failure: { message: 'boom', code: 'BOOM', status: 500 },
    });
    const chunks: {
      type: string;
      reason?: { kind: string; failure?: { code: string; status?: number } };
    }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(
        chunk as {
          type: string;
          reason?: { kind: string; failure?: { code: string; status?: number } };
        },
      );
    }
    const finish = chunks.find((c) => c.type === 'finish');
    expect(finish!.reason!.kind).toBe('error');
    expect(finish!.reason!.failure!.code).toBe('BOOM');
    expect(finish!.reason!.failure!.status).toBe(500);
  });

  it('error finish 无 failure 信息时使用默认值', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      finish: 'error',
    });
    const chunks: {
      type: string;
      reason?: { kind: string; failure?: { code: string; message: string } };
    }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(
        chunk as {
          type: string;
          reason?: { kind: string; failure?: { code: string; message: string } };
        },
      );
    }
    const finish = chunks.find((c) => c.type === 'finish');
    expect(finish!.reason!.kind).toBe('error');
    expect(finish!.reason!.failure!.code).toBe('FAKE_ERROR');
    expect(finish!.reason!.failure!.message).toBe('fake error');
  });

  it('aborted finish 带 failure 信息', async () => {
    const adapter = new FakeLlmAdapter(providers, models, {
      finish: 'aborted',
      failure: { message: 'cancelled', code: 'CANCELLED' },
    });
    const chunks: { type: string; reason?: { kind: string; failure?: { code: string } } }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks.push(chunk as { type: string; reason?: { kind: string; failure?: { code: string } } });
    }
    const finish = chunks.find((c) => c.type === 'finish');
    expect(finish!.reason!.kind).toBe('aborted');
    expect(finish!.reason!.failure!.code).toBe('CANCELLED');
  });

  it('函数脚本：按调用序号返回不同脚本', async () => {
    const scripts: FakeStreamScript[] = [
      { text: 'first', finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'second', finish: 'stop', usage: { inputTokens: 2, outputTokens: 2 } },
    ];
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      ((_opts: never, callIndex: number) => scripts[callIndex]!) as never,
    );
    // 第一次调用
    const chunks1: { type: string; text?: string }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks1.push(chunk as { type: string; text?: string });
    }
    const delta1 = chunks1.find((c) => c.type === 'text-delta');
    expect(delta1!.text).toBe('first');

    // 第二次调用
    const chunks2: { type: string; text?: string }[] = [];
    for await (const chunk of adapter.stream({
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
    } as never)) {
      chunks2.push(chunk as { type: string; text?: string });
    }
    const delta2 = chunks2.find((c) => c.type === 'text-delta');
    expect(delta2!.text).toBe('second');

    // calls 被记录
    expect(adapter.calls).toHaveLength(2);
  });
});

// ===== 脚本辅助函数 =====

describe('脚本辅助函数', () => {
  it('successScript 返回 text + usage + stop', () => {
    const script = successScript('hello', { inputTokens: 10, outputTokens: 5 });
    expect(script.text).toBe('hello');
    expect(script.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(script.finish).toBe('stop');
  });

  it('rateLimitScript 返回 429 错误', () => {
    const script = rateLimitScript();
    expect(script.finish).toBe('error');
    expect(script.failure).toBeDefined();
    expect(script.failure!.code).toBe('RATE_LIMIT');
    expect(script.failure!.status).toBe(429);
    expect(script.failure!.message).toBe('rate limited');
  });

  it('serverErrorScript 默认 503', () => {
    const script = serverErrorScript();
    expect(script.finish).toBe('error');
    expect(script.failure!.code).toBe('SERVER_ERROR');
    expect(script.failure!.status).toBe(503);
  });

  it('serverErrorScript 自定义状态码', () => {
    const script = serverErrorScript(500);
    expect(script.failure!.status).toBe(500);
  });

  it('timeoutScript 返回 TIMEOUT', () => {
    const script = timeoutScript();
    expect(script.finish).toBe('error');
    expect(script.failure!.code).toBe('TIMEOUT');
    expect(script.failure!.message).toBe('request timed out');
  });

  it('authErrorScript 返回 401', () => {
    const script = authErrorScript();
    expect(script.finish).toBe('error');
    expect(script.failure!.code).toBe('AUTH');
    expect(script.failure!.status).toBe(401);
    expect(script.failure!.message).toBe('unauthorized');
  });
});
