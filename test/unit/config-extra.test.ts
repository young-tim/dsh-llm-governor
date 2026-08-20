/**
 * Config Schema 补充单元测试：覆盖各 parser 的错误分支、withRevision、
 * 以及 resolveConfig 的各类拒绝场景。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveConfig,
  ConfigError,
  multiplierToPpm,
  creditsToNanos,
  withRevision,
  SCHEMA_VERSION,
} from '../../src/config/index.js';

/** 构造最小合法 raw 配置。 */
function minimalRaw(): Record<string, unknown> {
  return {
    schema_version: 1,
    identity: { provider: 'local' },
  };
}

// ===== withRevision =====

describe('config/withRevision', () => {
  it('设置合法 revision 返回新配置对象', () => {
    const cfg = resolveConfig(minimalRaw());
    const updated = withRevision(cfg, 5);
    expect(updated.revision).toBe(5);
    expect(cfg.revision).toBe(1);
    expect(updated).not.toBe(cfg);
  });

  it('revision=1 合法', () => {
    const cfg = resolveConfig(minimalRaw());
    const updated = withRevision(cfg, 1);
    expect(updated.revision).toBe(1);
  });

  it('revision=0 抛 ConfigError', () => {
    const cfg = resolveConfig(minimalRaw());
    expect(() => withRevision(cfg, 0)).toThrow(ConfigError);
  });

  it('revision=-1 抛 ConfigError', () => {
    const cfg = resolveConfig(minimalRaw());
    expect(() => withRevision(cfg, -1)).toThrow(ConfigError);
  });

  it('revision=0.5（非整数）抛 ConfigError', () => {
    const cfg = resolveConfig(minimalRaw());
    expect(() => withRevision(cfg, 0.5)).toThrow(ConfigError);
  });
});

// ===== 根级错误 =====

describe('config/根级错误', () => {
  it('root 不是对象抛 ConfigError', () => {
    expect(() => resolveConfig('not-an-object')).toThrow(ConfigError);
    expect(() => resolveConfig(42)).toThrow(ConfigError);
    expect(() => resolveConfig(null)).toThrow(ConfigError);
  });

  it('缺少 schema_version 抛 ConfigError', () => {
    expect(() => resolveConfig({ identity: { provider: 'local' } })).toThrow(
      /schema_version is required/,
    );
  });

  it('schema_version 非整数抛 ConfigError', () => {
    expect(() => resolveConfig({ schema_version: 1.5, identity: { provider: 'local' } })).toThrow(
      /schema_version must be integer/,
    );
  });

  it('schema_version 不等于 SCHEMA_VERSION 抛 ConfigError', () => {
    expect(() => resolveConfig({ schema_version: 2, identity: { provider: 'local' } })).toThrow(
      new RegExp(`schema_version must be ${SCHEMA_VERSION}`),
    );
  });

  it('缺少 identity 抛 ConfigError', () => {
    expect(() => resolveConfig({ schema_version: 1 })).toThrow(/identity is required/);
  });
});

// ===== Identity 错误分支 =====

describe('config/Identity 错误分支', () => {
  it('identity 不是对象抛 ConfigError', () => {
    expect(() => resolveConfig({ schema_version: 1, identity: 'not-an-object' })).toThrow(
      ConfigError,
    );
  });

  it('identity 缺少 provider 抛 ConfigError', () => {
    expect(() => resolveConfig({ schema_version: 1, identity: {} })).toThrow(
      /provider is required/,
    );
  });

  it('provider 不是合法枚举值抛 ConfigError', () => {
    expect(() => resolveConfig({ schema_version: 1, identity: { provider: 'bogus' } })).toThrow(
      /provider must be local\|header\|jwt\|custom/,
    );
  });

  it('provider=custom 合法（运行时经扩展注册表提供）', () => {
    const cfg = resolveConfig({ schema_version: 1, identity: { provider: 'custom' } });
    expect(cfg.identity.provider).toBe('custom');
  });

  it('provider 不是字符串抛 ConfigError', () => {
    expect(() => resolveConfig({ schema_version: 1, identity: { provider: 42 } })).toThrow(
      ConfigError,
    );
  });

  it('local_user_id 为空字符串抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local', local_user_id: '' },
      }),
    ).toThrow(/expected non-empty string/);
  });

  it('local_user_id 不是字符串抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local', local_user_id: 42 },
      }),
    ).toThrow(/expected string/);
  });

  it('header_name 为空字符串抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: {
          provider: 'header',
          header_name: '',
          trusted_proxy: 'my-ingress',
        },
      }),
    ).toThrow(/expected non-empty string/);
  });

  it('trusted_proxy 为空字符串抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'header', header_name: 'X-User', trusted_proxy: '' },
      }),
    ).toThrow(/expected non-empty string/);
  });

  it('jwt_issuer 为空字符串抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: {
          provider: 'jwt',
          jwt_issuer: '',
          jwt_audience: 'aud',
          jwt_algorithms: ['RS256'],
          jwt_key: 'k',
        },
      }),
    ).toThrow(/expected non-empty string/);
  });

  it('jwt_algorithms 不是数组抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: {
          provider: 'jwt',
          jwt_issuer: 'iss',
          jwt_audience: 'aud',
          jwt_algorithms: 'RS256',
          jwt_key: 'k',
        },
      }),
    ).toThrow(/expected array/);
  });

  it('jwt_algorithms 数组元素不是字符串抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: {
          provider: 'jwt',
          jwt_issuer: 'iss',
          jwt_audience: 'aud',
          jwt_algorithms: [42],
          jwt_key: 'k',
        },
      }),
    ).toThrow(/expected string/);
  });

  it('jwt_algorithms 空数组抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: {
          provider: 'jwt',
          jwt_issuer: 'iss',
          jwt_audience: 'aud',
          jwt_algorithms: [],
          jwt_key: 'k',
        },
      }),
    ).toThrow(/jwt_algorithms must not be empty/);
  });

  it('local provider 带 local_user_id 合法', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local', local_user_id: 'alice' },
    });
    expect(cfg.identity.localUserId).toBe('alice');
  });
});

// ===== Credits 错误分支 =====

describe('config/Credits 错误分支', () => {
  it('credits 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({ schema_version: 1, identity: { provider: 'local' }, credits: 42 }),
    ).toThrow(ConfigError);
  });

  it('tokens_per_credit 不是正整数抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        credits: { tokens_per_credit: 0 },
      }),
    ).toThrow(/expected positive integer/);
  });

  it('tokens_per_credit=0.5（非整数）抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        credits: { tokens_per_credit: 0.5 },
      }),
    ).toThrow(/expected positive integer/);
  });

  it('default_monthly_credits 为负数抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        credits: { default_monthly_credits: -1 },
      }),
    ).toThrow(/expected non-negative number/);
  });

  it('default_monthly_credits 不是数字抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        credits: { default_monthly_credits: 'abc' },
      }),
    ).toThrow(/expected finite number/);
  });

  it('timezone 无效抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        credits: { timezone: 'Not/A_Timezone' },
      }),
    ).toThrow(/invalid IANA timezone/);
  });

  it('tokens_per_credit 合法值通过', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local' },
      credits: { tokens_per_credit: 500_000, timezone: 'Asia/Shanghai' },
    });
    expect(cfg.credits.tokensPerCredit).toBe(500_000);
    expect(cfg.credits.timezone).toBe('Asia/Shanghai');
  });
});

// ===== Routing 错误分支 =====

describe('config/Routing 错误分支', () => {
  it('routing 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({ schema_version: 1, identity: { provider: 'local' }, routing: 42 }),
    ).toThrow(ConfigError);
  });

  it('routing.default 不是合法枚举值抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        routing: { default: 'bogus' },
      }),
    ).toThrow(/routing mode must be/);
  });

  it('routing.default 不是字符串抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        routing: { default: 42 },
      }),
    ).toThrow(/expected string/);
  });

  it('credit_first 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        routing: { credit_first: 42 },
      }),
    ).toThrow(ConfigError);
  });

  it('on_no_match 不是合法枚举值抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        routing: { credit_first: { on_no_match: 'bogus' } },
      }),
    ).toThrow(/on_no_match must be/);
  });

  it('minimum_quality 超出范围抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        routing: { credit_first: { minimum_quality: 101 } },
      }),
    ).toThrow(/expected quality in/);
  });

  it('合法 routing 配置通过', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local' },
      routing: {
        default: 'credit_first',
        credit_first: { minimum_quality: 85, on_no_match: 'quality_first' },
      },
    });
    expect(cfg.routing.default).toBe('credit_first');
    expect(cfg.routing.creditFirst.minimumQuality).toBe(85);
    expect(cfg.routing.creditFirst.onNoMatch).toBe('quality_first');
  });
});

// ===== Auto 错误分支 =====

describe('config/Auto 错误分支', () => {
  it('auto 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({ schema_version: 1, identity: { provider: 'local' }, auto: 42 }),
    ).toThrow(ConfigError);
  });

  it('confidence_threshold 超出 [0,1] 范围抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { confidence_threshold: 1.5 },
      }),
    ).toThrow(/expected number in \[0, 1\]/);
  });

  it('confidence_threshold 为负数抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { confidence_threshold: -0.1 },
      }),
    ).toThrow(/expected number in \[0, 1\]/);
  });

  it('quality_threshold 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { quality_threshold: 42 },
      }),
    ).toThrow(ConfigError);
  });

  it('quality_threshold.low 超出范围抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { quality_threshold: { low: -1 } },
      }),
    ).toThrow(/expected quality in/);
  });

  it('quality_threshold.high 超出范围抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { quality_threshold: { high: 101 } },
      }),
    ).toThrow(/expected quality in/);
  });

  it('llm_classifier 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { llm_classifier: 42 },
      }),
    ).toThrow(ConfigError);
  });

  it('llm_classifier.enabled 不是布尔值抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { llm_classifier: { enabled: 'yes' } },
      }),
    ).toThrow(/expected boolean/);
  });

  it('llm_classifier 启用但缺少 provider 抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { llm_classifier: { enabled: true, model: 'm' } },
      }),
    ).toThrow(/are required when enabled/);
  });

  it('llm_classifier 启用但缺少 model 抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { llm_classifier: { enabled: true, provider: 'p' } },
      }),
    ).toThrow(/are required when enabled/);
  });

  it('llm_classifier 启用且提供 provider+model 合法', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local' },
      auto: { llm_classifier: { enabled: true, provider: 'p', model: 'm' } },
    });
    expect(cfg.auto.llmClassifier.enabled).toBe(true);
    expect(cfg.auto.llmClassifier.provider).toBe('p');
    expect(cfg.auto.llmClassifier.model).toBe('m');
    expect(cfg.auto.llmClassifier.timeoutMs).toBe(10_000);
  });

  it('llm_classifier.timeout_ms 非正整数抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { llm_classifier: { timeout_ms: 0 } },
      }),
    ).toThrow(/expected positive integer/);
  });

  it('llm_classifier.timeout_ms 指定合法值通过', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local' },
      auto: { llm_classifier: { timeout_ms: 250 } },
    });
    expect(cfg.auto.llmClassifier.timeoutMs).toBe(250);
  });

  it('quality_threshold 全部指定合法', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local' },
      auto: { quality_threshold: { low: 70, medium: 80, high: 90 } },
    });
    expect(cfg.auto.qualityThreshold).toEqual({ low: 70, medium: 80, high: 90 });
  });
});

// ===== Fallback 错误分支 =====

describe('config/Fallback 错误分支', () => {
  it('fallback 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({ schema_version: 1, identity: { provider: 'local' }, fallback: 42 }),
    ).toThrow(ConfigError);
  });

  it('fallback.enabled 不是布尔值抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        fallback: { enabled: 'yes' },
      }),
    ).toThrow(/expected boolean/);
  });

  it('fallback.max_attempts 不是正整数抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        fallback: { max_attempts: 0 },
      }),
    ).toThrow(/expected positive integer/);
  });

  it('fallback.after_partial_output 不是布尔值抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        fallback: { after_partial_output: 1 },
      }),
    ).toThrow(/expected boolean/);
  });

  it('fallback.strategy 非法枚举抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        fallback: { strategy: 'cheapest' },
      }),
    ).toThrow(/strategy must be quality_first\|credit_first\|auto/);
  });

  it('合法 fallback 配置通过', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local' },
      fallback: { enabled: false, max_attempts: 3, after_partial_output: true, strategy: 'auto' },
    });
    expect(cfg.fallback.enabled).toBe(false);
    expect(cfg.fallback.maxAttempts).toBe(3);
    expect(cfg.fallback.afterPartialOutput).toBe(true);
    expect(cfg.fallback.strategy).toBe('auto');
  });

  it('fallback.strategy 默认 quality_first', () => {
    const cfg = resolveConfig({ schema_version: 1, identity: { provider: 'local' } });
    expect(cfg.fallback.strategy).toBe('quality_first');
  });
});

// ===== Models 错误分支 =====

describe('config/Models 错误分支', () => {
  it('models 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({ schema_version: 1, identity: { provider: 'local' }, models: 42 }),
    ).toThrow(ConfigError);
  });

  it('route_id 缺少冒号抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'no-colon': { enabled: true } },
      }),
    ).toThrow(/route id must be/);
  });

  it('route_id 冒号在末尾抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'provider:': { enabled: true } },
      }),
    ).toThrow(/route id must be/);
  });

  it('route_id 冒号在开头抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { ':model': { enabled: true } },
      }),
    ).toThrow(/route id must be/);
  });

  it('model entry 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': 42 },
      }),
    ).toThrow(ConfigError);
  });

  it('model enabled 不是布尔值抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': { enabled: 'yes' } },
      }),
    ).toThrow(/expected boolean/);
  });

  it('model multiplier 为负数抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': { multiplier: -1 } },
      }),
    ).toThrow(/expected non-negative number/);
  });

  it('model multiplier 不是数字抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': { multiplier: 'abc' } },
      }),
    ).toThrow(/expected finite number/);
  });

  it('model capabilities 不是数组抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': { capabilities: 'chat' } },
      }),
    ).toThrow(/expected array/);
  });

  it('model quality 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': { quality: 90 } },
      }),
    ).toThrow(ConfigError);
  });

  it('model quality 未知 task type 抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': { quality: { bogus: 90 } } },
      }),
    ).toThrow(/unknown task type/);
  });

  it('model quality 值超范围抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': { quality: { general: 101 } } },
      }),
    ).toThrow(/expected quality in/);
  });

  it('合法 model entry 通过', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local' },
      models: {
        'p:m': {
          enabled: false,
          multiplier: 1.5,
          capabilities: ['chat', 'vision'],
          quality: { general: 90, coding: 85 },
        },
      },
    });
    expect(cfg.models['p:m']!.enabled).toBe(false);
    expect(cfg.models['p:m']!.multiplierPpm).toBe(1_500_000);
    expect(cfg.models['p:m']!.capabilities).toEqual(['chat', 'vision']);
    expect(cfg.models['p:m']!.quality).toEqual({ general: 90, coding: 85 });
  });
});

// ===== Users 错误分支 =====

describe('config/Users 错误分支', () => {
  it('users 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({ schema_version: 1, identity: { provider: 'local' }, users: 42 }),
    ).toThrow(ConfigError);
  });

  it('user id 为空字符串抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        users: { '': { monthly_credits: 100 } },
      }),
    ).toThrow(/user id must not be empty/);
  });

  it('user entry 不是对象抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        users: { alice: 42 },
      }),
    ).toThrow(ConfigError);
  });

  it('user allow 不是数组抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        users: { alice: { allow: 'p:m' } },
      }),
    ).toThrow(/expected array/);
  });

  it('user monthly_credits 为负数抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        users: { alice: { monthly_credits: -1 } },
      }),
    ).toThrow(/expected non-negative number/);
  });

  it('合法 user entry 通过', () => {
    const cfg = resolveConfig({
      schema_version: 1,
      identity: { provider: 'local' },
      users: {
        alice: { allow: ['p:m'], monthly_credits: 200 },
      },
    });
    expect(cfg.users['alice']!.allow).toEqual(['p:m']);
    expect(cfg.users['alice']!.monthlyCredits).toBe(200n * 1_000_000_000n);
  });
});

// ===== 转换函数错误分支 =====

describe('config/转换函数错误分支', () => {
  it('multiplierToPpm: NaN 抛 ConfigError', () => {
    expect(() => multiplierToPpm(NaN)).toThrow(ConfigError);
  });

  it('multiplierToPpm: 负数抛 ConfigError', () => {
    expect(() => multiplierToPpm(-0.5)).toThrow(ConfigError);
  });

  it('multiplierToPpm: Infinity 抛 ConfigError', () => {
    expect(() => multiplierToPpm(Infinity)).toThrow(ConfigError);
  });

  it('creditsToNanos: NaN 抛 ConfigError', () => {
    expect(() => creditsToNanos(NaN)).toThrow(ConfigError);
  });

  it('creditsToNanos: 负数抛 ConfigError', () => {
    expect(() => creditsToNanos(-1)).toThrow(ConfigError);
  });

  it('creditsToNanos: Infinity 抛 ConfigError', () => {
    expect(() => creditsToNanos(Infinity)).toThrow(ConfigError);
  });
});

// ===== 未知字段拒绝（各 section）=====

describe('config/各 section 未知字段拒绝', () => {
  it('credits 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        credits: { unknown: 1 },
      }),
    ).toThrow(/unknown field "unknown"/);
  });

  it('routing 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        routing: { unknown: 1 },
      }),
    ).toThrow(/unknown field "unknown"/);
  });

  it('credit_first 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        routing: { credit_first: { unknown: 1 } },
      }),
    ).toThrow(/unknown field "unknown"/);
  });

  it('auto 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { unknown: 1 },
      }),
    ).toThrow(/unknown field "unknown"/);
  });

  it('quality_threshold 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { quality_threshold: { unknown: 1 } },
      }),
    ).toThrow(/unknown field "unknown"/);
  });

  it('llm_classifier 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        auto: { llm_classifier: { unknown: 1 } },
      }),
    ).toThrow(/unknown field "unknown"/);
  });

  it('fallback 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        fallback: { unknown: 1 },
      }),
    ).toThrow(/unknown field "unknown"/);
  });

  it('model entry 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        models: { 'p:m': { unknown: 1 } },
      }),
    ).toThrow(/unknown field "unknown"/);
  });

  it('user entry 未知字段抛 ConfigError', () => {
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'local' },
        users: { alice: { unknown: 1 } },
      }),
    ).toThrow(/unknown field "unknown"/);
  });
});
