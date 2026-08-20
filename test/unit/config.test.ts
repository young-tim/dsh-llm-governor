/**
 * Config 模块单元测试：验证 resolveConfig、未知字段拒绝、单位转换、Revision 管理。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveConfig,
  ConfigError,
  multiplierToPpm,
  creditsToNanos,
  bumpRevision,
  SCHEMA_VERSION,
  PPM_PER_MULTIPLIER,
  NANOS_PER_CREDIT,
} from '../../src/config/index.js';

/** 构造最小合法 raw 配置（仅含必填字段），用于测试默认值填充。 */
function minimalRaw(): Record<string, unknown> {
  return {
    schema_version: 1,
    identity: { provider: 'local' },
  };
}

describe('config/resolveConfig', () => {
  it('接受合法配置并填充所有默认值', () => {
    const cfg = resolveConfig(minimalRaw());
    expect(cfg.schemaVersion).toBe(SCHEMA_VERSION);
    expect(cfg.revision).toBe(1);
    // identity 默认 local_user_id="local"
    expect(cfg.identity).toEqual({
      provider: 'local',
      localUserId: 'local',
    });
    // credits 默认值
    expect(cfg.credits.tokensPerCredit).toBe(1_000_000);
    expect(cfg.credits.timezone).toBe('UTC');
    expect(cfg.credits.defaultMonthlyCredits).toBe(100n * NANOS_PER_CREDIT);
    // routing 默认值
    expect(cfg.routing.default).toBe('manual');
    expect(cfg.routing.creditFirst).toEqual({
      minimumQuality: 0,
      onNoMatch: 'none',
    });
    // auto 默认值
    expect(cfg.auto.confidenceThreshold).toBe(0.7);
    expect(cfg.auto.qualityThreshold).toEqual({
      low: 75,
      medium: 85,
      high: 92,
    });
    expect(cfg.auto.llmClassifier).toEqual({
      enabled: false,
      provider: '',
      model: '',
      timeoutMs: 10_000,
    });
    // fallback 默认值
    expect(cfg.fallback).toEqual({
      enabled: true,
      maxAttempts: 2,
      afterPartialOutput: false,
      strategy: 'quality_first',
    });
    expect(cfg.models).toEqual({});
    expect(cfg.users).toEqual({});
  });

  it('拒绝顶层未知字段（抛 ConfigError）', () => {
    const raw = { ...minimalRaw(), unknown_field: 1 };
    expect(() => resolveConfig(raw)).toThrow(ConfigError);
    expect(() => resolveConfig(raw)).toThrow(/unknown field "unknown_field"/);
  });

  it('拒绝 identity 块未知字段', () => {
    const raw = {
      schema_version: 1,
      identity: { provider: 'local', bogus: true },
    };
    expect(() => resolveConfig(raw)).toThrow(ConfigError);
    expect(() => resolveConfig(raw)).toThrow(/unknown field "bogus"/);
  });

  it('quality 超出 0..100 范围时被拒绝（上界）', () => {
    // 通过 routing.credit_first.minimum_quality 测上界
    const tooHigh = {
      schema_version: 1,
      identity: { provider: 'local' },
      routing: { credit_first: { minimum_quality: 101 } },
    };
    expect(() => resolveConfig(tooHigh)).toThrow(ConfigError);
    expect(() => resolveConfig(tooHigh)).toThrow(/expected quality in \[0, 100\]/);
  });

  it('quality 超出 0..100 范围时被拒绝（下界）', () => {
    // 通过 models.<route>.quality 测下界
    const tooLow = {
      schema_version: 1,
      identity: { provider: 'local' },
      models: { 'p:m': { quality: { general: -1 } } },
    };
    expect(() => resolveConfig(tooLow)).toThrow(ConfigError);
    expect(() => resolveConfig(tooLow)).toThrow(/expected quality in \[0, 100\]/);
  });

  it('quality 边界值 0 和 100 合法', () => {
    const raw = {
      schema_version: 1,
      identity: { provider: 'local' },
      routing: { credit_first: { minimum_quality: 0 } },
      models: {
        'p:m': {
          quality: { general: 100, coding: 0 },
          capabilities: [],
        },
      },
    };
    const cfg = resolveConfig(raw);
    expect(cfg.routing.creditFirst.minimumQuality).toBe(0);
    expect(cfg.models['p:m']!.quality.general).toBe(100);
    expect(cfg.models['p:m']!.quality.coding).toBe(0);
  });

  it('provider=header 时缺少 header_name 抛 ConfigError', () => {
    const raw = {
      schema_version: 1,
      identity: { provider: 'header' },
    };
    expect(() => resolveConfig(raw)).toThrow(ConfigError);
    expect(() => resolveConfig(raw)).toThrow(/header_name is required/);
  });

  it('provider=header 时缺少 trusted_proxy 抛 ConfigError（信任边界必须显式）', () => {
    const raw = {
      schema_version: 1,
      identity: { provider: 'header', header_name: 'X-User' },
    };
    expect(() => resolveConfig(raw)).toThrow(/trusted_proxy is required/);
  });

  it('provider=header 时提供 header_name + trusted_proxy 合法', () => {
    const raw = {
      schema_version: 1,
      identity: {
        provider: 'header',
        header_name: 'X-User',
        trusted_proxy: 'my-ingress',
        proxy_header_name: 'X-Proxy-Id',
        display_name_header: 'X-Display-Name',
        email_header: 'X-Email',
      },
    };
    const cfg = resolveConfig(raw);
    expect(cfg.identity.provider).toBe('header');
    expect(cfg.identity.headerName).toBe('X-User');
    expect(cfg.identity.trustedProxy).toBe('my-ingress');
    expect(cfg.identity.proxyHeaderName).toBe('X-Proxy-Id');
    expect(cfg.identity.displayNameHeader).toBe('X-Display-Name');
    expect(cfg.identity.emailHeader).toBe('X-Email');
  });

  it('provider=jwt 时缺少 issuer/audience/algorithms/key 均抛 ConfigError', () => {
    // 全缺
    expect(() => resolveConfig({ schema_version: 1, identity: { provider: 'jwt' } })).toThrow(
      /jwt_issuer is required/,
    );
    // 缺 audience
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: { provider: 'jwt', jwt_issuer: 'iss' },
      }),
    ).toThrow(/jwt_audience is required/);
    // 缺 algorithms
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: {
          provider: 'jwt',
          jwt_issuer: 'iss',
          jwt_audience: 'aud',
        },
      }),
    ).toThrow(/jwt_algorithms is required/);
    // 缺签名密钥（禁止无密钥的只 decode 部署）
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: {
          provider: 'jwt',
          jwt_issuer: 'iss',
          jwt_audience: 'aud',
          jwt_algorithms: ['RS256'],
        },
      }),
    ).toThrow(/jwt_key or jwt_key_file is required/);
    // jwt_key 与 jwt_key_file 互斥
    expect(() =>
      resolveConfig({
        schema_version: 1,
        identity: {
          provider: 'jwt',
          jwt_issuer: 'iss',
          jwt_audience: 'aud',
          jwt_algorithms: ['HS256'],
          jwt_key: 'secret',
          jwt_key_file: '/etc/governor/pub.pem',
        },
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('provider=jwt 时提供完整字段（含密钥与可选项）合法', () => {
    const raw = {
      schema_version: 1,
      identity: {
        provider: 'jwt',
        jwt_issuer: 'iss',
        jwt_audience: 'aud',
        jwt_algorithms: ['RS256', 'ES256'],
        jwt_key: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
        jwt_subject_claim: 'sub',
        jwt_header_name: 'x-auth-token',
        jwt_scheme: '',
        jwt_clock_tolerance_ms: 5000,
      },
    };
    const cfg = resolveConfig(raw);
    expect(cfg.identity.jwtIssuer).toBe('iss');
    expect(cfg.identity.jwtAudience).toBe('aud');
    expect(cfg.identity.jwtAlgorithms).toEqual(['RS256', 'ES256']);
    expect(cfg.identity.jwtKey).toContain('BEGIN PUBLIC KEY');
    expect(cfg.identity.jwtSubjectClaim).toBe('sub');
    expect(cfg.identity.jwtHeaderName).toBe('x-auth-token');
    expect(cfg.identity.jwtScheme).toBe('');
    expect(cfg.identity.jwtClockToleranceMs).toBe(5000);
  });

  it('storage/ui 段解析（默认启用）', () => {
    const cfg = resolveConfig(minimalRaw());
    expect(cfg.storage).toEqual({ enabled: true });
    expect(cfg.ui).toEqual({ enabled: true, port: 0 });
    const cfg2 = resolveConfig({
      ...minimalRaw(),
      storage: { enabled: false, path: '/tmp/gov.db' },
      ui: { enabled: false, port: 3757 },
    });
    expect(cfg2.storage).toEqual({ enabled: false, path: '/tmp/gov.db' });
    expect(cfg2.ui).toEqual({ enabled: false, port: 3757 });
    // ui.port 范围校验
    expect(() => resolveConfig({ ...minimalRaw(), ui: { port: 70000 } })).toThrow(
      /port in \[1, 65535\]/,
    );
  });
});

describe('config/单位转换', () => {
  it('multiplierToPpm: 1x = 1_000_000, 0.5x = 500_000, 2x = 2_000_000', () => {
    expect(multiplierToPpm(1)).toBe(PPM_PER_MULTIPLIER);
    expect(multiplierToPpm(0.5)).toBe(500_000);
    expect(multiplierToPpm(2)).toBe(2_000_000);
  });

  it('multiplierToPpm: 0x = 0（免计费模型）', () => {
    expect(multiplierToPpm(0)).toBe(0);
  });

  it('creditsToNanos: 1 Credit = 1_000_000_000 nanos', () => {
    expect(creditsToNanos(1)).toBe(NANOS_PER_CREDIT);
    expect(creditsToNanos(0.5)).toBe(500_000_000n);
    expect(creditsToNanos(100)).toBe(100n * NANOS_PER_CREDIT);
  });

  it('monthly_credits 通过 resolveConfig 转换为 nanos', () => {
    const raw = {
      schema_version: 1,
      identity: { provider: 'local' },
      credits: { default_monthly_credits: 50 },
    };
    const cfg = resolveConfig(raw);
    expect(cfg.credits.defaultMonthlyCredits).toBe(50n * NANOS_PER_CREDIT);
  });

  it('user.monthly_credits 通过 resolveConfig 转换为 nanos', () => {
    const raw = {
      schema_version: 1,
      identity: { provider: 'local' },
      users: {
        alice: { monthly_credits: 200 },
      },
    };
    const cfg = resolveConfig(raw);
    expect(cfg.users['alice']!.monthlyCredits).toBe(200n * NANOS_PER_CREDIT);
  });

  it('models.<route>.multiplier 通过 resolveConfig 转换为 ppm', () => {
    const raw = {
      schema_version: 1,
      identity: { provider: 'local' },
      models: {
        'p:m': { multiplier: 0.5 },
      },
    };
    const cfg = resolveConfig(raw);
    expect(cfg.models['p:m']!.multiplierPpm).toBe(500_000);
  });
});

describe('config/bumpRevision', () => {
  it('每次调用将 revision 递增 1', () => {
    const cfg = resolveConfig(minimalRaw());
    expect(cfg.revision).toBe(1);
    const r2 = bumpRevision(cfg);
    expect(r2.revision).toBe(2);
    const r3 = bumpRevision(r2);
    expect(r3.revision).toBe(3);
  });

  it('不修改原对象（返回新不可变快照）', () => {
    const cfg = resolveConfig(minimalRaw());
    const r2 = bumpRevision(cfg);
    expect(cfg.revision).toBe(1);
    expect(r2).not.toBe(cfg);
    // 其余字段应保持引用一致
    expect(r2.identity).toBe(cfg.identity);
    expect(r2.credits).toBe(cfg.credits);
  });
});
