/**
 * 扩展注册点集成测试（需求基线 §6）：四个领域扩展的运行时注册与真实生效。
 *
 * 1. Custom IdentityProvider：identity.provider=custom，未注册 fail closed；
 *    经 ctx.governor.extensions 注册后入站绑定成功。
 * 2. Custom TaskClassifier：注册后分类完全由扩展接管（决策落库可验证）。
 * 3. Custom RoutingStrategy：按名接管对应非 Manual 模式的路由决策；
 *    Manual Fallback 重选同样尊重注册的策略。
 * 4. ModelQualityProvider：按维度覆盖治理配置的 Quality，改变路由选择。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootFake, modelInfo } from '../contracts/harness.js';
import { successScript, rateLimitScript } from '../../src/dsh-adapter/fake-adapter.js';
import type { FakeStreamScript } from '../../src/dsh-adapter/fake-adapter.js';
import { CustomIdentityProvider } from '../../src/identity/providers.js';
import { IdentityError } from '../../src/identity/types.js';
import type { RoutingStrategy } from '../../src/extensions/registry.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';

/** 构造 fake agent。 */
function fakeAgent(id = 'session-1') {
  return { id };
}

/** 事件分发辅助。 */
function ev(ctx: unknown) {
  return (
    ctx as unknown as {
      events: { waterfall: (name: string, ...args: unknown[]) => Promise<unknown> };
    }
  ).events;
}

const providers = ['fake-provider'];
const models = [
  modelInfo('fake-provider', 'model-a', 'Model A'),
  modelInfo('fake-provider', 'model-b', 'Model B'),
  modelInfo('fake-provider', 'model-c', 'Model C'),
];

/** 按模型选择脚本：model-a 返回 429，其余成功。 */
function scriptForModel(options: { model: string }): FakeStreamScript {
  if (options.model === 'model-a') return rateLimitScript();
  return successScript('ok', { inputTokens: 1, outputTokens: 1 });
}

/** 三模型基础配置：A 质量最高，B/C 次之。 */
function baseConfig() {
  return {
    models: {
      'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
      'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
      'fake-provider:model-c': { enabled: true, multiplier: 0.1, quality: { general: 70 } },
    },
    routing: { default: 'quality_first' as const },
    fallback: { enabled: true, max_attempts: 2 },
    identity: { provider: 'local' as const, local_user_id: 'local' },
  };
}

// ===== Custom IdentityProvider =====

describe('扩展/Custom IdentityProvider', () => {
  it('provider=custom：未注册时绑定与请求均 fail closed', async () => {
    const h = await bootFake(providers, models, scriptForModel as never, {
      ...baseConfig(),
      identity: { provider: 'custom' as const },
      users: { 'ext-user': { allow: [], monthly_credits: 100 } },
    });
    try {
      // 未注册自定义提供者 → 绑定拒绝（fail closed）
      await expect(
        h.governor!.bindIdentityFromHeaders('session-1', { 'X-Any': 'value' }),
      ).rejects.toThrow('IDENTITY_PROVIDER_NOT_CONFIGURED');
      // 无绑定 → 请求被拒
      await expect(
        ev(h.ctx).waterfall(
          'agent/request',
          { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ).rejects.toMatchObject({ code: 'IDENTITY_REQUIRED' });
    } finally {
      await h.dispose();
    }
  });

  it('注册后 bindIdentityFromHeaders 使用扩展解析身份，请求通过', async () => {
    const h = await bootFake(providers, models, scriptForModel as never, {
      ...baseConfig(),
      identity: { provider: 'custom' as const },
      users: { 'ext-user': { allow: [], monthly_credits: 100 } },
    });
    try {
      // 第三方插件在运行时注册自定义身份提供者（ctx.governor.extensions）
      h.governor!.extensions.registerIdentityProvider(
        new CustomIdentityProvider(async (ctx) => {
          if (ctx.headers?.['X-Governor-User'] === undefined) {
            throw new IdentityError('IDENTITY_REQUIRED', 'missing X-Governor-User header');
          }
          return { userId: ctx.headers['X-Governor-User'] };
        }, 'header-custom'),
      );
      // 扩展解析身份 → 绑定成功
      const identity = await h.governor!.bindIdentityFromHeaders('session-1', {
        'X-Governor-User': 'ext-user',
      });
      expect(identity.userId).toBe('ext-user');
      expect(h.governor!.getIdentity('session-1')).toMatchObject({ userId: 'ext-user' });
      // 绑定后请求通过
      const config = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config.model).toBe('model-a');
      // 扩展自身的 fail closed：缺少 Header 时拒绝
      await expect(h.governor!.bindIdentityFromHeaders('session-2', {})).rejects.toMatchObject({
        code: 'IDENTITY_REQUIRED',
      });
    } finally {
      await h.dispose();
    }
  });
});

// ===== Custom TaskClassifier =====

describe('扩展/Custom TaskClassifier', () => {
  it('注册后分类完全由扩展接管（决策落库验证）', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-ext-cls-'));
    const dbPath = join(dbDir, 'governor.db');
    // auto 路由：内置分类 'hello world' 会得到 general/medium/0（→ quality_first →
    // model-a）；扩展给出 coding/high/0.9（→ credit_first min_quality 92 → model-b，
    // 唯一 coding>=92 的模型），选择结果可证明扩展接管。
    const h = await bootFake(
      providers,
      models,
      scriptForModel as never,
      {
        models: {
          'fake-provider:model-a': {
            enabled: true,
            multiplier: 1,
            quality: { general: 90, coding: 90 },
          },
          'fake-provider:model-b': {
            enabled: true,
            multiplier: 0.5,
            quality: { general: 80, coding: 95 },
          },
          'fake-provider:model-c': {
            enabled: true,
            multiplier: 0.1,
            quality: { general: 70, coding: 70 },
          },
        },
        routing: { default: 'auto' as const },
        fallback: { enabled: true, max_attempts: 2 },
        identity: { provider: 'local' as const, local_user_id: 'local' },
      },
      { dbPath },
    );
    try {
      // 注册自定义分类器：恒定返回 coding/high/0.9（覆盖内置 Hint/Rule/LLM）
      h.governor!.extensions.registerTaskClassifier({
        classify: async () => ({
          taskType: 'coding',
          complexity: 'high',
          confidence: 0.9,
          source: 'llm',
        }),
      });
      await ev(h.ctx).waterfall(
        'agent/pre-step',
        {
          agent: fakeAgent(),
          // 普通文本：内置 Rule 不会给出 coding/high/0.9，可证明扩展接管
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ kind: 'enter', messages: [] }),
      );
      // coding/high/0.9 → credit_first(min 92) → model-b（唯一 coding>=92）
      const config = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config.model).toBe('model-b');

      // 决策落库：分类来自扩展（coding/high/0.9）
      const db = new GovernorDatabase(dbPath);
      const repo = new GovernorRepository(db);
      const requestId = h.governor!.getRequestId('session-1', 1, 1)!;
      const decisions = repo.getDecisions(requestId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.taskType).toBe('coding');
      expect(decisions[0]!.complexity).toBe('high');
      expect(decisions[0]!.confidence).toBe(0.9);
      db.close();
    } finally {
      await h.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

// ===== Custom RoutingStrategy =====

/** 自定义策略：按 Multiplier 升序选择（与内置 quality_first 相反）。 */
function multiplierFirstStrategy(name: RoutingStrategy['name']): RoutingStrategy {
  return {
    name,
    select: (input) => {
      const sorted = [...input.snapshots].sort((a, b) => a.multiplierPpm - b.multiplierPpm);
      const selected = sorted[0]!;
      return {
        selected,
        decision: {
          requestId: 'custom-strategy',
          fallbackIndex: 0,
          mode: name,
          candidates: [],
          excluded: [],
          selected: selected.routeId,
          configRevision: 1,
          createdAt: new Date().toISOString(),
        },
      };
    },
  };
}

describe('扩展/Custom RoutingStrategy', () => {
  it('注册 quality_first 策略后接管该模式：按倍率选择而非质量', async () => {
    const h = await bootFake(providers, models, scriptForModel as never, baseConfig());
    try {
      // 未注册：内置 quality_first 选 model-a（质量 90 最高）
      const config1 = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config1.model).toBe('model-a');

      // 注册自定义 quality_first 策略：按倍率升序 → model-c（0.1x 最便宜）
      h.governor!.extensions.registerRoutingStrategy(multiplierFirstStrategy('quality_first'));
      const config2 = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent('session-2'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config2.model).toBe('model-c');

      // 注销后恢复内置行为
      h.governor!.extensions.unregisterRoutingStrategy('quality_first');
      const config3 = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent('session-3'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config3.model).toBe('model-a');
    } finally {
      await h.dispose();
    }
  });

  it('Manual Fallback 重选同样尊重注册的策略', async () => {
    const h = await bootFake(providers, models, scriptForModel as never, {
      ...baseConfig(),
      routing: { default: 'manual' as const },
    });
    try {
      // 注册自定义 quality_first：Manual Fallback 默认策略被接管（按倍率 → model-c）
      h.governor!.extensions.registerRoutingStrategy(multiplierFirstStrategy('quality_first'));
      const e = ev(h.ctx);
      // 第一次：Manual 保留用户选择 model-a
      const config1 = (await e.waterfall(
        'agent/request',
        { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config1.model).toBe('model-a');
      // model-a 失败（429）→ 排除并重试
      const action = await e.waterfall(
        'agent/request-error',
        {
          agent: fakeAgent(),
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
      // 重试：内置 quality_first 会选 model-b（质量 80），扩展策略选 model-c（0.1x）
      const config2 = (await e.waterfall(
        'agent/request',
        { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config2.model).toBe('model-c');
    } finally {
      await h.dispose();
    }
  });
});

// ===== ModelQualityProvider =====

describe('扩展/ModelQualityProvider', () => {
  it('注册后按维度覆盖治理配置的 Quality，改变 quality_first 选择', async () => {
    const h = await bootFake(providers, models, scriptForModel as never, baseConfig());
    try {
      // 未注册：内置行为选 model-a（general 90 最高）
      const config1 = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config1.model).toBe('model-a');

      // 注册质量提供者：把 model-c 的 general 提到 99（覆盖治理配置的 70）
      h.governor!.extensions.registerModelQualityProvider({
        getQuality: (routeId) => (routeId === 'fake-provider:model-c' ? { general: 99 } : {}),
      });
      const config2 = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent('session-2'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config2.model).toBe('model-c');

      // 注销后恢复治理配置视角
      h.governor!.extensions.unregisterModelQualityProvider();
      const config3 = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent('session-3'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config3.model).toBe('model-a');
    } finally {
      await h.dispose();
    }
  });
});
