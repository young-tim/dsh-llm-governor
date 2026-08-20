/**
 * 扩展注册表单元测试（§6 四个扩展点的运行时注册 API）：
 * 注册/注销/查找、非法参数拒绝、manual 不允许注册为 RoutingStrategy。
 */
import { describe, it, expect } from 'vitest';
import { GovernorExtensionRegistry } from '../../src/extensions/registry.js';
import type {
  TaskClassifier,
  RoutingStrategy,
  ModelQualityProvider,
} from '../../src/extensions/registry.js';
import type { IdentityProvider } from '../../src/identity/types.js';
import { CustomIdentityProvider } from '../../src/identity/providers.js';

/** 构造一个固定的自定义身份提供者。 */
function fakeIdentityProvider(userId: string): IdentityProvider {
  return new CustomIdentityProvider(async () => ({ userId }), 'fake-custom');
}

// ===== IdentityProvider =====

describe('extensions/IdentityProvider', () => {
  it('注册后可查找，注销后不可查找', () => {
    const registry = new GovernorExtensionRegistry();
    expect(registry.getIdentityProvider()).toBeUndefined();
    const provider = fakeIdentityProvider('ext-user');
    registry.registerIdentityProvider(provider);
    expect(registry.getIdentityProvider()).toBe(provider);
    registry.unregisterIdentityProvider();
    expect(registry.getIdentityProvider()).toBeUndefined();
  });

  it('kind 为空字符串拒绝注册', () => {
    const registry = new GovernorExtensionRegistry();
    const bad = {
      kind: '',
      resolve: async () => ({ userId: 'u' }),
    } as unknown as IdentityProvider;
    expect(() => registry.registerIdentityProvider(bad)).toThrow(
      'EXTENSION_INVALID_IDENTITY_PROVIDER',
    );
  });

  it('后注册者覆盖先注册者（单槽位）', () => {
    const registry = new GovernorExtensionRegistry();
    const first = fakeIdentityProvider('first');
    const second = fakeIdentityProvider('second');
    registry.registerIdentityProvider(first);
    registry.registerIdentityProvider(second);
    expect(registry.getIdentityProvider()).toBe(second);
  });
});

// ===== TaskClassifier =====

describe('extensions/TaskClassifier', () => {
  it('注册后可查找，注销后不可查找', () => {
    const registry = new GovernorExtensionRegistry();
    expect(registry.getTaskClassifier()).toBeUndefined();
    const classifier: TaskClassifier = {
      classify: async () => ({
        taskType: 'coding',
        complexity: 'high',
        confidence: 1,
        source: 'llm',
      }),
    };
    registry.registerTaskClassifier(classifier);
    expect(registry.getTaskClassifier()).toBe(classifier);
    registry.unregisterTaskClassifier();
    expect(registry.getTaskClassifier()).toBeUndefined();
  });
});

// ===== RoutingStrategy =====

describe('extensions/RoutingStrategy', () => {
  /** 构造一个按名注册的空策略。 */
  function fakeStrategy(name: RoutingStrategy['name']): RoutingStrategy {
    return {
      name,
      select: (input) => {
        const snap = input.snapshots[0]!;
        return {
          selected: snap,
          decision: {
            requestId: 'ext',
            fallbackIndex: 0,
            mode: name,
            candidates: [],
            excluded: [],
            selected: snap.routeId,
            configRevision: 1,
            createdAt: new Date().toISOString(),
          },
        };
      },
    };
  }

  it('合法策略名注册后可按名查找', () => {
    const registry = new GovernorExtensionRegistry();
    const strategy = fakeStrategy('quality_first');
    registry.registerRoutingStrategy(strategy);
    expect(registry.getRoutingStrategy('quality_first')).toBe(strategy);
    expect(registry.getRoutingStrategy('auto')).toBeUndefined();
    expect(registry.listRoutingStrategyNames()).toEqual(['quality_first']);
    registry.unregisterRoutingStrategy('quality_first');
    expect(registry.getRoutingStrategy('quality_first')).toBeUndefined();
  });

  it('manual 不允许注册（Manual 语义受产品保证保护）', () => {
    const registry = new GovernorExtensionRegistry();
    expect(() =>
      registry.registerRoutingStrategy(fakeStrategy('manual' as RoutingStrategy['name'])),
    ).toThrow('EXTENSION_INVALID_ROUTING_STRATEGY');
  });

  it('非法策略名拒绝注册', () => {
    const registry = new GovernorExtensionRegistry();
    expect(() =>
      registry.registerRoutingStrategy(fakeStrategy('cheapest' as RoutingStrategy['name'])),
    ).toThrow('EXTENSION_INVALID_ROUTING_STRATEGY');
  });
});

// ===== ModelQualityProvider =====

describe('extensions/ModelQualityProvider', () => {
  it('注册后可查找，注销后不可查找', () => {
    const registry = new GovernorExtensionRegistry();
    expect(registry.getModelQualityProvider()).toBeUndefined();
    const provider: ModelQualityProvider = {
      getQuality: () => ({ general: 99 }),
    };
    registry.registerModelQualityProvider(provider);
    expect(registry.getModelQualityProvider()).toBe(provider);
    registry.unregisterModelQualityProvider();
    expect(registry.getModelQualityProvider()).toBeUndefined();
  });
});
