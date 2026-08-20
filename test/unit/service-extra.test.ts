/**
 * GovernorService 补充单元测试：覆盖 updateModel、updateUser、refreshModelDirectory、
 * setQuotaExceeded、getCurrentTurnStep、getSelectedRoute、setClassification、
 * classifyError、canRetry、recordAttempt、configRevision、getRequestId、getFallbackIndex
 * 等未覆盖的方法。
 *
 * 使用 bootFake harness 启动真实 Governor 实例，直接调用 service 方法。
 */
import { describe, it, expect } from 'vitest';
import { bootFake, modelInfo } from '../contracts/harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';

/** 默认 Governor 配置：包含两个模型和一个用户。 */
function defaultConfig() {
  return {
    models: {
      'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
      'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
    },
    users: {
      local: { allow: [], monthly_credits: 100 },
      alice: { allow: ['fake-provider:model-a'], monthly_credits: 200 },
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

// ===== updateModel =====

describe('GovernorService/updateModel', () => {
  it('更新已存在模型的 enabled 状态', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      const result = await h.governor!.updateModel('fake-provider:model-a', { enabled: false });
      expect(result.routeId).toBe('fake-provider:model-a');
      expect(result.enabled).toBe(false);
      // multiplier 保持不变
      expect(result.multiplierPpm).toBe(1_000_000);
    } finally {
      await h.dispose();
    }
  });

  it('更新已存在模型的 multiplier（人类可读倍率 → ppm）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      const result = await h.governor!.updateModel('fake-provider:model-b', { multiplier: 2 });
      // 2x → 2_000_000 ppm
      expect(result.multiplierPpm).toBe(2_000_000);
      // enabled 保持不变
      expect(result.enabled).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('同时更新 enabled 和 multiplier', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      const result = await h.governor!.updateModel('fake-provider:model-a', {
        enabled: false,
        multiplier: 0.5,
      });
      expect(result.enabled).toBe(false);
      expect(result.multiplierPpm).toBe(500_000);
    } finally {
      await h.dispose();
    }
  });

  it('空 patch 返回当前状态不变', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      const result = await h.governor!.updateModel('fake-provider:model-a', {});
      expect(result.enabled).toBe(true);
      expect(result.multiplierPpm).toBe(1_000_000);
    } finally {
      await h.dispose();
    }
  });

  it('不存在的 routeId 抛 MODEL_NOT_FOUND', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      await expect(
        h.governor!.updateModel('fake-provider:no-such-model', { enabled: false }),
      ).rejects.toThrow('MODEL_NOT_FOUND');
    } finally {
      await h.dispose();
    }
  });

  it('更新后 listModels 反映新状态', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      await h.governor!.updateModel('fake-provider:model-a', { enabled: false, multiplier: 3 });
      const list = await h.governor!.listModels();
      const modelA = list.find((m) => m.routeId === 'fake-provider:model-a');
      expect(modelA).toBeDefined();
      expect(modelA!.enabled).toBe(false);
      expect(modelA!.multiplierPpm).toBe(3_000_000);
    } finally {
      await h.dispose();
    }
  });
});

// ===== updateUser =====

describe('GovernorService/updateUser', () => {
  it('更新已存在用户的 monthlyCredits', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      const result = await h.governor!.updateUser('local', { monthlyCredits: 999 });
      expect(result.userId).toBe('local');
      expect(result.monthlyCredits).toBe(999);
      // allow 保持不变
      expect(result.allow).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it('更新有白名单用户的 monthlyCredits，allow 不变', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      const result = await h.governor!.updateUser('alice', { monthlyCredits: 500 });
      expect(result.monthlyCredits).toBe(500);
      expect(result.allow).toEqual(['fake-provider:model-a']);
    } finally {
      await h.dispose();
    }
  });

  it('空 patch 返回当前状态不变', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      const result = await h.governor!.updateUser('local', {});
      expect(result.monthlyCredits).toBe(100);
    } finally {
      await h.dispose();
    }
  });

  it('不存在的 userId 抛 USER_NOT_FOUND', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      await expect(h.governor!.updateUser('nobody', { monthlyCredits: 1 })).rejects.toThrow(
        'USER_NOT_FOUND',
      );
    } finally {
      await h.dispose();
    }
  });

  it('更新后 listUsers 反映新额度', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      await h.governor!.updateUser('local', { monthlyCredits: 1234 });
      const users = await h.governor!.listUsers();
      const local = users.find((u) => u.userId === 'local');
      expect(local).toBeDefined();
      expect(local!.monthlyCredits).toBe(1234);
    } finally {
      await h.dispose();
    }
  });
});

// ===== refreshModelDirectory =====

describe('GovernorService/refreshModelDirectory', () => {
  it('用新的 advisory 刷新模型目录', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      // 初始目录有 2 个模型
      const before = await h.governor!.listModels();
      expect(before).toHaveLength(2);

      // 刷新：传入一个新 provider 和模型
      await h.governor!.refreshModelDirectory(
        () => [{ id: 'fake-provider' }, { id: 'new-provider' }],
        async (p) => {
          if (p === 'fake-provider') {
            return [
              { provider: 'fake-provider', id: 'model-a', name: 'Model A' },
              { provider: 'fake-provider', id: 'model-b', name: 'Model B' },
              { provider: 'fake-provider', id: 'model-c', name: 'Model C' },
            ];
          }
          return [{ provider: 'new-provider', id: 'model-x', name: 'Model X' }];
        },
      );

      // 刷新后目录应包含 advisory 中的模型
      const after = await h.governor!.listModels();
      const routeIds = after.map((m) => m.routeId);
      // 应包含原有的 fake-provider 模型 + 新增的 model-c 和 new-provider:model-x
      expect(routeIds).toContain('fake-provider:model-a');
      expect(routeIds).toContain('fake-provider:model-b');
      expect(routeIds).toContain('fake-provider:model-c');
      expect(routeIds).toContain('new-provider:model-x');
    } finally {
      await h.dispose();
    }
  });

  it('advisory 为空时回退到配置构建的目录', async () => {
    // 使用一个只有配置模型、没有 advisory 的 bootFake
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      // 刷新：传入空的 provider 列表
      await h.governor!.refreshModelDirectory(
        () => [],
        async () => [],
      );
      // 应回退到配置构建的目录（2 个模型）
      const after = await h.governor!.listModels();
      expect(after).toHaveLength(2);
      expect(after.map((m) => m.routeId).sort()).toEqual([
        'fake-provider:model-a',
        'fake-provider:model-b',
      ]);
    } finally {
      await h.dispose();
    }
  });

  it('advisory 模型带 description 和 inputModalities', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      await h.governor!.refreshModelDirectory(
        () => [{ id: 'fake-provider' }],
        async () => [
          {
            provider: 'fake-provider',
            id: 'model-a',
            name: 'Model A',
            description: 'A capable model',
            inputModalities: ['text', 'image'],
          },
        ],
      );
      // 刷新成功，模型目录包含 model-a
      const list = await h.governor!.listModels();
      expect(list.some((m) => m.routeId === 'fake-provider:model-a')).toBe(true);
    } finally {
      await h.dispose();
    }
  });
});

// ===== setQuotaExceeded =====

describe('GovernorService/setQuotaExceeded', () => {
  it('设置 true 后该用户的请求被拒绝（NO_MODEL_MATCHED）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      await h.governor!.bindIdentity('session-1', { userId: 'user-1' });
      h.governor!.setQuotaExceeded('user-1', true);
      await expect(
        (
          h.ctx.events as unknown as {
            waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
          }
        ).waterfall(
          'agent/request',
          {
            agent: { id: 'session-1' },
            turn: 1,
            step: 1,
            signal: new AbortController().signal,
          },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ).rejects.toMatchObject({ code: 'NO_MODEL_MATCHED' });
    } finally {
      await h.dispose();
    }
  });

  it('设置 false 后恢复正常', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      await h.governor!.bindIdentity('session-1', { userId: 'user-1' });
      h.governor!.setQuotaExceeded('user-1', true);
      h.governor!.setQuotaExceeded('user-1', false);
      const config = (await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        {
          agent: { id: 'session-1' },
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config.model).toBe('model-a');
    } finally {
      await h.dispose();
    }
  });

  it('未绑定身份的用户不受 quota 限制', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      // 不绑定身份，即使设置 quota exceeded 也不影响（identity 为 undefined）
      h.governor!.setQuotaExceeded('user-1', true);
      const config = (await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        {
          agent: { id: 'session-unbound' },
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config.model).toBe('model-a');
    } finally {
      await h.dispose();
    }
  });
});

// ===== getCurrentTurnStep / getSelectedRoute =====

describe('GovernorService/getCurrentTurnStep + getSelectedRoute', () => {
  it('selectModel 后 getCurrentTurnStep 返回最新 turn/step', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      // 调用前未设置
      expect(h.governor!.getCurrentTurnStep('session-1')).toBeUndefined();
      // 触发 agent/request（内部调用 selectModel）
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        {
          agent: { id: 'session-1' },
          turn: 3,
          step: 7,
          signal: new AbortController().signal,
        },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      expect(h.governor!.getCurrentTurnStep('session-1')).toEqual({ turn: 3, step: 7 });
    } finally {
      await h.dispose();
    }
  });

  it('selectModel 后 getSelectedRoute 返回所选 routeId', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      // 调用前未设置
      expect(h.governor!.getSelectedRoute('session-1', 1, 1)).toBeUndefined();
      // 触发 agent/request
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        {
          agent: { id: 'session-1' },
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      // quality_first 选择 model-a（质量更高）
      const selected = h.governor!.getSelectedRoute('session-1', 1, 1);
      expect(selected).toBe('fake-provider:model-a');
    } finally {
      await h.dispose();
    }
  });
});

// ===== auto routing + setClassification =====

describe('GovernorService/auto routing + setClassification', () => {
  it('auto 路由使用默认分类（未设置 classification 时）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'auto' as const },
      },
    );
    try {
      const config = (await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        {
          agent: { id: 'session-1' },
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { provider: string; model: string };
      // auto 路由应返回有效配置
      expect(config.provider).toBe('fake-provider');
      // 决策记录的 mode 应为 auto
      const decisions = await h.governor!.listDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.mode).toBe('auto');
    } finally {
      await h.dispose();
    }
  });

  it('setClassification 设置后 auto 路由使用该分类', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'auto' as const },
      },
    );
    try {
      // 设置分类为 general/medium（models 配置中有 general quality）
      h.governor!.setClassification('session-1', 1, 1, {
        taskType: 'general',
        complexity: 'medium',
        confidence: 0.9,
        source: 'rule',
      });
      const config = (await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        {
          agent: { id: 'session-1' },
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { provider: string; model: string };
      expect(config.provider).toBe('fake-provider');
      // 决策已记录
      const decisions = await h.governor!.listDecisions();
      expect(decisions).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  });
});

// ===== classifyError / canRetry =====

describe('GovernorService/classifyError + canRetry', () => {
  it('classifyError 对可重试错误返回 true（fallback 启用）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      // 429 是可重试的
      expect(
        h.governor!.classifyError({
          message: 'rate limited',
          code: 'RATE_LIMIT',
          status: 429,
        } as never),
      ).toBe(true);
      // 5xx 是可重试的
      expect(
        h.governor!.classifyError({
          message: 'server error',
          code: 'SERVER_ERROR',
          status: 503,
        } as never),
      ).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('classifyError 对不可重试错误返回 false', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      // 401 不可重试
      expect(
        h.governor!.classifyError({ message: 'unauthorized', code: 'AUTH', status: 401 } as never),
      ).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it('fallback 禁用时 classifyError 总是返回 false', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        fallback: { enabled: false, max_attempts: 2 },
      },
    );
    try {
      expect(
        h.governor!.classifyError({ message: '429', code: 'RATE_LIMIT', status: 429 } as never),
      ).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it('canRetry 在未达上限时返回 true', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      // 第一次 attempt
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        { agent: { id: 'session-1' }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      // 第一次 attempt 后 canRetry=true（1 < 2）
      expect(h.governor!.canRetry('session-1', 1, 1)).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('canRetry 在达到 max_attempts 后返回 false', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      // 两次 attempt（达到 max_attempts=2）
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        { agent: { id: 'session-1' }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        { agent: { id: 'session-1' }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-b' }),
      );
      // 已达到 max_attempts=2 → canRetry=false
      expect(h.governor!.canRetry('session-1', 1, 1)).toBe(false);
    } finally {
      await h.dispose();
    }
  });
});

// ===== recordAttempt / configRevision / getRequestId / getFallbackIndex =====

describe('GovernorService/其他未覆盖方法', () => {
  it('recordAttempt 直接调用创建请求状态', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      // recordAttempt 创建 request state
      h.governor!.recordAttempt('session-x', 1, 1);
      // requestId 应已分配
      const requestId = h.governor!.getRequestId('session-x', 1, 1);
      expect(requestId).toBeDefined();
      expect(typeof requestId).toBe('string');
      // fallbackIndex 初始为 0
      expect(h.governor!.getFallbackIndex('session-x', 1, 1)).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it('configRevision 返回 1', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      expect(h.governor!.configRevision).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it('getRequestId 对未创建的请求状态返回 undefined', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      expect(h.governor!.getRequestId('nonexistent', 1, 1)).toBeUndefined();
      // 未创建状态的 fallbackIndex 为 0
      expect(h.governor!.getFallbackIndex('nonexistent', 1, 1)).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it('getFallbackIndex 在 selectModel 后反映正确的 fallback 序号', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      // 第一次 selectModel → fallbackIndex=0
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        { agent: { id: 'session-1' }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      expect(h.governor!.getFallbackIndex('session-1', 1, 1)).toBe(0);

      // 第二次 selectModel → fallbackIndex=1
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        { agent: { id: 'session-1' }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-b' }),
      );
      expect(h.governor!.getFallbackIndex('session-1', 1, 1)).toBe(1);
    } finally {
      await h.dispose();
    }
  });
});

// ===== markPartialOutput / getExcludedRoutes 直接调用 =====

describe('GovernorService/markPartialOutput + getExcludedRoutes', () => {
  it('markPartialOutput 对已存在请求状态标记部分输出', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      {
        ...defaultConfig(),
        routing: { default: 'quality_first' as const },
      },
    );
    try {
      await (
        h.ctx.events as unknown as {
          waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
        }
      ).waterfall(
        'agent/request',
        { agent: { id: 'session-1' }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      // 标记部分输出
      h.governor!.markPartialOutput('session-1', 1, 1);
      // 不抛错即通过；getExcludedRoutes 初始为空
      const excluded = h.governor!.getExcludedRoutes('session-1', 1, 1);
      expect(excluded.size).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it('markPartialOutput 对不存在的请求状态不抛错', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }),
      defaultConfig(),
    );
    try {
      // 不存在的请求状态 → 不抛错
      h.governor!.markPartialOutput('nonexistent', 1, 1);
      // getExcludedRoutes 对不存在的状态返回空 Set
      const excluded = h.governor!.getExcludedRoutes('nonexistent', 1, 1);
      expect(excluded.size).toBe(0);
    } finally {
      await h.dispose();
    }
  });
});
