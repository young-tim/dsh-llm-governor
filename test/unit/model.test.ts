/**
 * Model 模块单元测试：覆盖 canonicalRoute/parseRoute/mergeModel/resolveBareModel/buildModelDirectory。
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalRoute,
  parseRoute,
  mergeModel,
  resolveBareModel,
  buildModelDirectory,
} from '../../src/model/index.js';
import type { AdvisoryModelInfo, ModelPolicyEntry } from '../../src/model/index.js';

// ===== canonicalRoute =====

describe('canonicalRoute', () => {
  it('返回 "provider:model"', () => {
    expect(canonicalRoute('openai', 'gpt-4')).toBe('openai:gpt-4');
  });

  it('provider/model 含特殊字符时仍按 ":"拼接', () => {
    expect(canonicalRoute('p-1', 'm_2')).toBe('p-1:m_2');
  });
});

// ===== parseRoute =====

describe('parseRoute', () => {
  it('正确解析 provider:model', () => {
    expect(parseRoute('openai:gpt-4')).toEqual({ provider: 'openai', model: 'gpt-4' });
  });

  it('model 中包含冒号时仍按首个冒号解析', () => {
    expect(parseRoute('p:m:extra')).toEqual({ provider: 'p', model: 'm:extra' });
  });

  it('无冒号抛错', () => {
    expect(() => parseRoute('no-colon')).toThrow(/INVALID_ROUTE_ID/);
  });

  it('以冒号开头抛错（provider 为空）', () => {
    expect(() => parseRoute(':model')).toThrow(/INVALID_ROUTE_ID/);
  });

  it('以冒号结尾抛错（model 为空）', () => {
    expect(() => parseRoute('provider:')).toThrow(/INVALID_ROUTE_ID/);
  });
});

// ===== mergeModel =====

describe('mergeModel', () => {
  const advisory: AdvisoryModelInfo = {
    provider: 'openai',
    id: 'gpt-4',
    name: 'GPT-4',
    description: 'desc',
    inputModalities: ['text'],
  };

  it('合并 advisory 和 policy，未配置 multiplierPpm 时默认 1_000_000 (1x)', () => {
    // policy 缺席 → multiplierPpm 默认 1x
    const snap = mergeModel(advisory, undefined)!;
    expect(snap.routeId).toBe('openai:gpt-4');
    expect(snap.provider).toBe('openai');
    expect(snap.model).toBe('gpt-4');
    expect(snap.enabled).toBe(true);
    expect(snap.multiplierPpm).toBe(1_000_000);
    expect(snap.capabilities).toEqual([]);
    expect(snap.quality).toEqual({});
    expect(snap.inAdvisory).toBe(true);
    expect(snap.name).toBe('GPT-4');
    expect(snap.description).toBe('desc');
    expect(snap.inputModalities).toEqual(['text']);
  });

  it('合并 advisory 和 policy，policy 显式 multiplierPpm 生效', () => {
    const policy: ModelPolicyEntry = {
      routeId: 'openai:gpt-4',
      provider: 'openai',
      model: 'gpt-4',
      enabled: false,
      multiplierPpm: 2_000_000,
      capabilities: ['chat', 'vision'],
      quality: { general: 90, coding: 80 },
    };
    const snap = mergeModel(advisory, policy)!;
    expect(snap.enabled).toBe(false);
    expect(snap.multiplierPpm).toBe(2_000_000);
    expect(snap.capabilities).toEqual(['chat', 'vision']);
    expect(snap.quality).toEqual({ general: 90, coding: 80 });
    expect(snap.inAdvisory).toBe(true);
  });

  it('advisory 缺席但 policy 存在时保留', () => {
    const policy: ModelPolicyEntry = {
      routeId: 'openai:gpt-4',
      provider: 'openai',
      model: 'gpt-4',
      enabled: true,
      multiplierPpm: 500_000,
      capabilities: ['chat'],
      quality: { coding: 80 },
    };
    const snap = mergeModel(undefined, policy)!;
    expect(snap.routeId).toBe('openai:gpt-4');
    expect(snap.provider).toBe('openai');
    expect(snap.model).toBe('gpt-4');
    expect(snap.enabled).toBe(true);
    expect(snap.multiplierPpm).toBe(500_000);
    expect(snap.capabilities).toEqual(['chat']);
    expect(snap.quality).toEqual({ coding: 80 });
    expect(snap.inAdvisory).toBe(false);
    // advisory 缺席时 name 回落到 model
    expect(snap.name).toBe('gpt-4');
  });

  it('advisory 和 policy 同时缺失返回 undefined', () => {
    expect(mergeModel(undefined, undefined)).toBeUndefined();
  });

  it('advisory 无 description 时 snapshot 也不含 description', () => {
    const minimal: AdvisoryModelInfo = {
      provider: 'openai',
      id: 'gpt-4',
      name: 'GPT-4',
    };
    const snap = mergeModel(minimal, undefined)!;
    expect(snap.description).toBeUndefined();
    expect(snap.inputModalities).toBeUndefined();
  });
});

// ===== resolveBareModel =====

describe('resolveBareModel', () => {
  it('唯一匹配返回 canonical route', () => {
    const advisoryByProvider = new Map<string, readonly AdvisoryModelInfo[]>([
      ['openai', [{ provider: 'openai', id: 'gpt-4', name: 'GPT-4' }]],
      ['anthropic', [{ provider: 'anthropic', id: 'claude-3', name: 'Claude 3' }]],
    ]);
    expect(resolveBareModel('gpt-4', advisoryByProvider)).toBe('openai:gpt-4');
    expect(resolveBareModel('claude-3', advisoryByProvider)).toBe('anthropic:claude-3');
  });

  it('多个 provider 中存在同名 model 返回 AMBIGUOUS_MODEL_ROUTE', () => {
    const advisoryByProvider = new Map<string, readonly AdvisoryModelInfo[]>([
      ['openai', [{ provider: 'openai', id: 'shared', name: 'S1' }]],
      ['anthropic', [{ provider: 'anthropic', id: 'shared', name: 'S2' }]],
    ]);
    expect(resolveBareModel('shared', advisoryByProvider)).toBe('AMBIGUOUS_MODEL_ROUTE');
  });

  it('无匹配也返回 AMBIGUOUS_MODEL_ROUTE', () => {
    const advisoryByProvider = new Map<string, readonly AdvisoryModelInfo[]>([
      ['openai', [{ provider: 'openai', id: 'gpt-4', name: 'GPT-4' }]],
    ]);
    expect(resolveBareModel('unknown', advisoryByProvider)).toBe('AMBIGUOUS_MODEL_ROUTE');
  });

  it('同一 provider 内重复 id 不算冲突', () => {
    const advisoryByProvider = new Map<string, readonly AdvisoryModelInfo[]>([
      [
        'openai',
        [
          { provider: 'openai', id: 'gpt-4', name: 'GPT-4' },
          { provider: 'openai', id: 'gpt-4', name: 'GPT-4 Dup' },
        ],
      ],
    ]);
    expect(resolveBareModel('gpt-4', advisoryByProvider)).toBe('openai:gpt-4');
  });
});

// ===== buildModelDirectory =====

describe('buildModelDirectory', () => {
  it('合并 advisory + policies，保留 advisory 缺席但 provider 活动的策略', () => {
    const advisoryByProvider = new Map<string, readonly AdvisoryModelInfo[]>([
      [
        'openai',
        [
          { provider: 'openai', id: 'gpt-4', name: 'GPT-4' },
          { provider: 'openai', id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
      ],
    ]);
    const policies = new Map<string, ModelPolicyEntry>([
      // advisory 中存在 → 合并
      [
        'openai:gpt-4',
        {
          routeId: 'openai:gpt-4',
          provider: 'openai',
          model: 'gpt-4',
          enabled: true,
          multiplierPpm: 1_500_000,
          capabilities: ['chat'],
          quality: { general: 90 },
        },
      ],
      // advisory 缺席但 provider 活动 → 保留
      [
        'openai:gpt-4-32k',
        {
          routeId: 'openai:gpt-4-32k',
          provider: 'openai',
          model: 'gpt-4-32k',
          enabled: true,
          multiplierPpm: 2_000_000,
          capabilities: [],
          quality: {},
        },
      ],
      // provider 不活动 → 剔除
      [
        'other:model-x',
        {
          routeId: 'other:model-x',
          provider: 'other',
          model: 'model-x',
          enabled: true,
          multiplierPpm: 1_000_000,
          capabilities: [],
          quality: {},
        },
      ],
    ]);

    const directory = buildModelDirectory(advisoryByProvider, policies);
    const routeIds = directory.map((s) => s.routeId).sort();
    expect(routeIds).toEqual(['openai:gpt-3.5', 'openai:gpt-4', 'openai:gpt-4-32k']);

    // gpt-4 合并了 policy
    const gpt4 = directory.find((s) => s.routeId === 'openai:gpt-4')!;
    expect(gpt4.multiplierPpm).toBe(1_500_000);
    expect(gpt4.capabilities).toEqual(['chat']);
    expect(gpt4.inAdvisory).toBe(true);
    expect(gpt4.name).toBe('GPT-4');

    // gpt-3.5 无 policy → 使用默认
    const gpt35 = directory.find((s) => s.routeId === 'openai:gpt-3.5')!;
    expect(gpt35.multiplierPpm).toBe(1_000_000);
    expect(gpt35.inAdvisory).toBe(true);

    // gpt-4-32k advisory 缺席但保留
    const gpt432k = directory.find((s) => s.routeId === 'openai:gpt-4-32k')!;
    expect(gpt432k.inAdvisory).toBe(false);
    expect(gpt432k.name).toBe('gpt-4-32k');
    expect(gpt432k.multiplierPpm).toBe(2_000_000);
  });

  it('空 advisory + 空 policies 返回空数组', () => {
    expect(buildModelDirectory(new Map(), new Map())).toEqual([]);
  });
});
