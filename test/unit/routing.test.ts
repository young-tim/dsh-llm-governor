/**
 * Routing 模块单元测试：公共过滤、四种确定性策略、属性测试、fail closed 验证。
 * 覆盖 filterCandidates / routeManual / routeQualityFirst / routeCreditFirst / routeAuto。
 */
import { describe, it, expect } from 'vitest';
import {
  filterCandidates,
  routeManual,
  routeQualityFirst,
  routeCreditFirst,
  routeAuto,
  RoutingError,
} from '../../src/routing/index.js';
import type { FilterInput, RoutingErrorCode } from '../../src/routing/index.js';
import type { ModelSnapshot } from '../../src/model/canonical.js';
import type { UserAccessPolicy } from '../../src/access/evaluator.js';

// ===== 测试数据 helper =====

/** 构造 ModelSnapshot 的可选项。 */
interface SnapshotOpts {
  enabled?: boolean;
  multiplierPpm?: number;
  capabilities?: readonly string[];
  quality?: ModelSnapshot['quality'];
  inputModalities?: readonly string[];
  name?: string;
  inAdvisory?: boolean;
}

/**
 * 构造一个 ModelSnapshot。
 * @param routeId - `provider:model` 格式的 canonical route。
 * @param opts - 可选字段（缺省 enabled=true、multiplierPpm=1_000_000）。
 */
function makeSnapshot(routeId: string, opts: SnapshotOpts = {}): ModelSnapshot {
  const idx = routeId.indexOf(':');
  const provider = routeId.slice(0, idx);
  const model = routeId.slice(idx + 1);
  return {
    routeId,
    provider,
    model,
    enabled: opts.enabled ?? true,
    multiplierPpm: opts.multiplierPpm ?? 1_000_000,
    capabilities: opts.capabilities ?? [],
    quality: opts.quality ?? {},
    name: opts.name ?? model,
    inAdvisory: opts.inAdvisory ?? true,
    // exactOptionalPropertyTypes：仅在有值时展开可选属性
    ...(opts.inputModalities ? { inputModalities: opts.inputModalities } : {}),
  };
}

/** 构造 FilterInput 的可选项。 */
interface FilterInputOpts {
  activeProviders?: ReadonlySet<string>;
  globalDefault?: ReadonlySet<string>;
  userPolicy?: UserAccessPolicy;
  excludedRoutes?: ReadonlySet<string>;
  requiredCapabilities?: readonly string[];
  requiredModalities?: readonly string[];
  quotaCheck?: (routeId: string) => boolean;
}

/**
 * 构造一个 FilterInput。
 * 默认让全部 snapshot 通过：所有 provider 活动、所有 route 在全局默认、quota 全放行。
 * 测试可通过 opts 选择性收紧。
 * @param snapshots - 候选模型快照。
 * @param opts - 覆盖默认过滤条件的可选项。
 */
function makeFilterInput(
  snapshots: readonly ModelSnapshot[],
  opts: FilterInputOpts = {},
): FilterInput {
  return {
    snapshots,
    activeProviders: opts.activeProviders ?? new Set(snapshots.map((s) => s.provider)),
    globalDefault: opts.globalDefault ?? new Set(snapshots.map((s) => s.routeId)),
    userPolicy: opts.userPolicy,
    excludedRoutes: opts.excludedRoutes ?? new Set(),
    requiredCapabilities: opts.requiredCapabilities ?? [],
    requiredModalities: opts.requiredModalities ?? [],
    quotaCheck: opts.quotaCheck ?? (() => true),
  };
}

/** 从排除列表中查找指定 route 的原因码。 */
function exclusionReason(
  excluded: ReadonlyArray<{ routeId: string; reason: string }>,
  routeId: string,
): string | undefined {
  return excluded.find((e) => e.routeId === routeId)?.reason;
}

/** 断言函数抛出 RoutingError 且 code 匹配。 */
function expectRoutingError(fn: () => unknown, code: RoutingErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RoutingError);
  expect((caught as RoutingError).code).toBe(code);
}

// ===== 公共过滤 filterCandidates =====

describe('filterCandidates 公共过滤', () => {
  it('disabled 模型被排除', () => {
    const snap = makeSnapshot('p1:m-disabled', { enabled: false });
    const result = filterCandidates(makeFilterInput([snap]));
    expect(result.candidates).toHaveLength(0);
    expect(exclusionReason(result.excluded, 'p1:m-disabled')).toBe('disabled');
  });

  it('不在活动 provider 中的模型被排除', () => {
    const snap = makeSnapshot('p-inactive:m1');
    const result = filterCandidates(
      makeFilterInput([snap], { activeProviders: new Set(['p-other']) }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(exclusionReason(result.excluded, 'p-inactive:m1')).toBe('not_active_provider');
  });

  it('access denied（不在全局默认）被排除', () => {
    const snap = makeSnapshot('p1:m1');
    // 无 userPolicy → 使用全局默认；globalDefault 为空 → 拒绝
    const result = filterCandidates(makeFilterInput([snap], { globalDefault: new Set() }));
    expect(result.candidates).toHaveLength(0);
    expect(exclusionReason(result.excluded, 'p1:m1')).toBe('access_denied');
  });

  it('access denied（不在 allow list）被排除', () => {
    const snap = makeSnapshot('p1:m1');
    const userPolicy: UserAccessPolicy = { userId: 'u1', allow: ['p1:m-other'] };
    const result = filterCandidates(makeFilterInput([snap], { userPolicy }));
    expect(result.candidates).toHaveLength(0);
    expect(exclusionReason(result.excluded, 'p1:m1')).toBe('access_denied');
  });

  it('缺少能力被排除', () => {
    const snap = makeSnapshot('p1:m1', { capabilities: ['vision'] });
    const result = filterCandidates(
      makeFilterInput([snap], { requiredCapabilities: ['tool_use'] }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(exclusionReason(result.excluded, 'p1:m1')).toBe('capability_not_supported');
  });

  it('已在请求排除集中的被排除', () => {
    const snap = makeSnapshot('p1:m1');
    const result = filterCandidates(
      makeFilterInput([snap], { excludedRoutes: new Set(['p1:m1']) }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(exclusionReason(result.excluded, 'p1:m1')).toBe('excluded_in_request');
  });

  it('quota 不允许的被排除', () => {
    const snap = makeSnapshot('p1:m1');
    const result = filterCandidates(makeFilterInput([snap], { quotaCheck: () => false }));
    expect(result.candidates).toHaveLength(0);
    expect(exclusionReason(result.excluded, 'p1:m1')).toBe('quota_exceeded');
  });

  it('通过的候选被保留并维持原顺序', () => {
    const s1 = makeSnapshot('p1:m1', { capabilities: ['tool_use'], quality: { general: 90 } });
    const s2 = makeSnapshot('p1:m2', { capabilities: ['tool_use'], quality: { general: 80 } });
    const result = filterCandidates(
      makeFilterInput([s1, s2], { requiredCapabilities: ['tool_use'] }),
    );
    expect(result.candidates.map((c) => c.routeId)).toEqual(['p1:m1', 'p1:m2']);
    expect(result.excluded).toHaveLength(0);
  });

  it('过滤顺序稳定：disabled 优先于 access_denied', () => {
    // 既 disabled 又不在全局默认 → 应记为 disabled（enabled 检查在 access 之前）
    const snap = makeSnapshot('p1:m1', { enabled: false });
    const result = filterCandidates(makeFilterInput([snap], { globalDefault: new Set() }));
    expect(exclusionReason(result.excluded, 'p1:m1')).toBe('disabled');
  });
});

// ===== Manual 策略 =====

describe('routeManual', () => {
  it('请求的模型存在且通过过滤 → 返回该模型', () => {
    const s1 = makeSnapshot('p1:m1', { quality: { general: 80 } });
    const s2 = makeSnapshot('p1:m2', { quality: { general: 95 } });
    const result = routeManual(makeFilterInput([s1, s2]), 'p1', 'm1');
    expect(result.selected.routeId).toBe('p1:m1');
    expect(result.decision.mode).toBe('manual');
    expect(result.decision.selected).toBe('p1:m1');
  });

  it('请求 disabled 模型 → 抛 MODEL_DISABLED', () => {
    const s1 = makeSnapshot('p1:m1', { enabled: false });
    expectRoutingError(() => routeManual(makeFilterInput([s1]), 'p1', 'm1'), 'MODEL_DISABLED');
  });

  it('请求不存在的模型 → 抛 MODEL_NOT_FOUND', () => {
    const s1 = makeSnapshot('p1:m1');
    expectRoutingError(() => routeManual(makeFilterInput([s1]), 'p1', 'nope'), 'MODEL_NOT_FOUND');
  });

  it('Manual 失败时绝不自动替换', () => {
    // 请求 disabled 模型，即便存在另一个高质量可用模型，也应抛错而非替换
    const sDisabled = makeSnapshot('p1:m1', { enabled: false });
    const sOk = makeSnapshot('p1:m2', { enabled: true, quality: { general: 99 } });
    expectRoutingError(
      () => routeManual(makeFilterInput([sDisabled, sOk]), 'p1', 'm1'),
      'MODEL_DISABLED',
    );
  });

  it('请求 access denied 模型 → 抛 MODEL_ACCESS_DENIED', () => {
    const s1 = makeSnapshot('p1:m1');
    expectRoutingError(
      () => routeManual(makeFilterInput([s1], { globalDefault: new Set() }), 'p1', 'm1'),
      'MODEL_ACCESS_DENIED',
    );
  });

  it('请求 quota 耗尽模型 → 抛 QUOTA_EXCEEDED', () => {
    const s1 = makeSnapshot('p1:m1');
    expectRoutingError(
      () => routeManual(makeFilterInput([s1], { quotaCheck: () => false }), 'p1', 'm1'),
      'QUOTA_EXCEEDED',
    );
  });
});

// ===== Quality First 策略 =====

describe('routeQualityFirst', () => {
  it('按 quality 降序选择最高质量', () => {
    const s1 = makeSnapshot('p1:low', { quality: { general: 70 }, multiplierPpm: 500_000 });
    const s2 = makeSnapshot('p1:high', { quality: { general: 95 }, multiplierPpm: 2_000_000 });
    const s3 = makeSnapshot('p1:mid', { quality: { general: 85 }, multiplierPpm: 800_000 });
    const result = routeQualityFirst(makeFilterInput([s1, s2, s3]), 'general');
    expect(result.selected.routeId).toBe('p1:high');
    expect(result.decision.mode).toBe('quality_first');
  });

  it('缺少 quality 的被排除为 quality_missing', () => {
    const s1 = makeSnapshot('p1:has', { quality: { general: 80 } });
    const s2 = makeSnapshot('p1:missing', { quality: { coding: 90 } });
    const result = routeQualityFirst(makeFilterInput([s1, s2]), 'general');
    expect(result.selected.routeId).toBe('p1:has');
    expect(exclusionReason(result.decision.excluded, 'p1:missing')).toBe('quality_missing');
  });

  it('Tie-break：quality 相同时 multiplier 升序', () => {
    const s1 = makeSnapshot('p1:expensive', { quality: { general: 90 }, multiplierPpm: 2_000_000 });
    const s2 = makeSnapshot('p1:cheap', { quality: { general: 90 }, multiplierPpm: 500_000 });
    const result = routeQualityFirst(makeFilterInput([s1, s2]), 'general');
    expect(result.selected.routeId).toBe('p1:cheap');
  });

  it('Tie-break：quality 与 multiplier 相同时 route 字典序', () => {
    const s1 = makeSnapshot('p1:zebra', { quality: { general: 90 }, multiplierPpm: 1_000_000 });
    const s2 = makeSnapshot('p1:alpha', { quality: { general: 90 }, multiplierPpm: 1_000_000 });
    const result = routeQualityFirst(makeFilterInput([s1, s2]), 'general');
    expect(result.selected.routeId).toBe('p1:alpha');
  });

  it('无候选 → 抛 NO_MODEL_MATCHED', () => {
    const s1 = makeSnapshot('p1:missing', { quality: { coding: 90 } });
    expectRoutingError(
      () => routeQualityFirst(makeFilterInput([s1]), 'general'),
      'NO_MODEL_MATCHED',
    );
  });
});

// ===== Credit First 策略 =====

describe('routeCreditFirst', () => {
  it('先过滤 quality >= minimum_quality，再按 multiplier 升序选择', () => {
    const s1 = makeSnapshot('p1:cheap-low', { quality: { general: 76 }, multiplierPpm: 400_000 });
    const s2 = makeSnapshot('p1:expensive-high', {
      quality: { general: 99 },
      multiplierPpm: 2_000_000,
    });
    const s3 = makeSnapshot('p1:below', { quality: { general: 74 }, multiplierPpm: 100_000 });
    const result = routeCreditFirst(makeFilterInput([s1, s2, s3]), 'general', 75);
    // s3 低于阈值被排除；s1 multiplier 最低 → 选中
    expect(result.selected.routeId).toBe('p1:cheap-low');
    expect(result.decision.minimumQuality).toBe(75);
    expect(result.decision.mode).toBe('credit_first');
  });

  it('无模型达标 → 抛 NO_MODEL_MATCHED', () => {
    const s1 = makeSnapshot('p1:low', { quality: { general: 50 } });
    expectRoutingError(
      () => routeCreditFirst(makeFilterInput([s1]), 'general', 75),
      'NO_MODEL_MATCHED',
    );
  });

  it('on_no_match: quality_first 时切换到 Quality First', () => {
    // 无模型达到 minimum_quality=90，但 fallback 应选最高质量
    const s1 = makeSnapshot('p1:low', { quality: { general: 50 }, multiplierPpm: 100_000 });
    const s2 = makeSnapshot('p1:high', { quality: { general: 80 }, multiplierPpm: 2_000_000 });
    const result = routeCreditFirst(makeFilterInput([s1, s2]), 'general', 90, 1, 'quality_first');
    expect(result.selected.routeId).toBe('p1:high');
    expect(result.decision.mode).toBe('quality_first');
  });

  it('Tie-break：multiplier 相同时 quality 降序', () => {
    const s1 = makeSnapshot('p1:low-q', { quality: { general: 80 }, multiplierPpm: 1_000_000 });
    const s2 = makeSnapshot('p1:high-q', { quality: { general: 95 }, multiplierPpm: 1_000_000 });
    const result = routeCreditFirst(makeFilterInput([s1, s2]), 'general', 75);
    expect(result.selected.routeId).toBe('p1:high-q');
  });

  it('Tie-break：multiplier 与 quality 相同时 route 字典序', () => {
    const s1 = makeSnapshot('p1:zeta', { quality: { general: 90 }, multiplierPpm: 1_000_000 });
    const s2 = makeSnapshot('p1:alpha', { quality: { general: 90 }, multiplierPpm: 1_000_000 });
    const result = routeCreditFirst(makeFilterInput([s1, s2]), 'general', 75);
    expect(result.selected.routeId).toBe('p1:alpha');
  });
});

// ===== Auto 策略 =====

describe('routeAuto', () => {
  it('低置信度切 Quality First', () => {
    const s1 = makeSnapshot('p1:low', { quality: { general: 70 }, multiplierPpm: 100_000 });
    const s2 = makeSnapshot('p1:high', { quality: { general: 95 }, multiplierPpm: 2_000_000 });
    const classification = {
      taskType: 'general',
      complexity: 'high',
      confidence: 0.4,
      source: 'rule',
    };
    // confidence 0.4 < 0.6 → Quality First → 选高质量
    const result = routeAuto(makeFilterInput([s1, s2]), classification, 0.6);
    expect(result.selected.routeId).toBe('p1:high');
    expect(result.decision.mode).toBe('auto');
    expect(result.decision.complexity).toBe('high');
    expect(result.decision.confidence).toBe(0.4);
  });

  it('高置信度映射复杂度 low → minimum_quality 75 再 Credit First', () => {
    const s1 = makeSnapshot('p1:below', { quality: { general: 70 }, multiplierPpm: 100_000 });
    const s2 = makeSnapshot('p1:above', { quality: { general: 80 }, multiplierPpm: 500_000 });
    const classification = {
      taskType: 'general',
      complexity: 'low',
      confidence: 0.9,
      source: 'llm',
    };
    // low → 75 → s1(70) 排除，s2(80) 通过
    const result = routeAuto(makeFilterInput([s1, s2]), classification, 0.6);
    expect(result.selected.routeId).toBe('p1:above');
    expect(result.decision.mode).toBe('auto');
    expect(result.decision.minimumQuality).toBe(75);
  });

  it('高置信度映射复杂度 medium → minimum_quality 85', () => {
    const s1 = makeSnapshot('p1:a', { quality: { general: 80 }, multiplierPpm: 100_000 });
    const s2 = makeSnapshot('p1:b', { quality: { general: 90 }, multiplierPpm: 500_000 });
    const classification = {
      taskType: 'general',
      complexity: 'medium',
      confidence: 0.9,
      source: 'llm',
    };
    // medium → 85 → s1(80) 排除，s2(90) 通过
    const result = routeAuto(makeFilterInput([s1, s2]), classification, 0.6);
    expect(result.selected.routeId).toBe('p1:b');
    expect(result.decision.minimumQuality).toBe(85);
  });

  it('高置信度映射复杂度 high → minimum_quality 92', () => {
    const s1 = makeSnapshot('p1:a', { quality: { general: 90 }, multiplierPpm: 100_000 });
    const s2 = makeSnapshot('p1:b', { quality: { general: 95 }, multiplierPpm: 500_000 });
    const classification = {
      taskType: 'general',
      complexity: 'high',
      confidence: 0.9,
      source: 'llm',
    };
    // high → 92 → s1(90) 排除，s2(95) 通过
    const result = routeAuto(makeFilterInput([s1, s2]), classification, 0.6);
    expect(result.selected.routeId).toBe('p1:b');
    expect(result.decision.minimumQuality).toBe(92);
  });
});

// ===== 属性测试：乱序候选结果不变 =====

describe('属性测试：乱序候选结果不变', () => {
  /** mulberry32 确定性 PRNG，保证属性测试可复现。 */
  function mulberry32(seed: number): () => number {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fisher-Yates 洗牌，返回新数组。 */
  function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = a[i]!;
      a[i] = a[j]!;
      a[j] = tmp;
    }
    return a;
  }

  it('Quality First：多次 shuffle 后 selected 不变', () => {
    const snaps = [
      makeSnapshot('p1:m-a', { quality: { general: 88 }, multiplierPpm: 1_200_000 }),
      makeSnapshot('p1:m-b', { quality: { general: 95 }, multiplierPpm: 2_000_000 }),
      makeSnapshot('p1:m-c', { quality: { general: 88 }, multiplierPpm: 800_000 }),
      makeSnapshot('p1:m-d', { quality: { general: 95 }, multiplierPpm: 2_000_000 }),
      makeSnapshot('p1:m-e', { quality: { general: 70 }, multiplierPpm: 300_000 }),
    ];
    // 95 最高；m-b 与 m-d 同质量同 multiplier → 字典序 m-b 胜出
    const baseline = routeQualityFirst(makeFilterInput(snaps), 'general').selected.routeId;
    expect(baseline).toBe('p1:m-b');
    for (let seed = 1; seed <= 50; seed++) {
      const shuffled = shuffle(snaps, mulberry32(seed));
      const selected = routeQualityFirst(makeFilterInput(shuffled), 'general').selected.routeId;
      expect(selected).toBe(baseline);
    }
  });

  it('Credit First：多次 shuffle 后 selected 不变', () => {
    const snaps = [
      makeSnapshot('p1:m-a', { quality: { general: 88 }, multiplierPpm: 1_200_000 }),
      makeSnapshot('p1:m-b', { quality: { general: 95 }, multiplierPpm: 2_000_000 }),
      makeSnapshot('p1:m-c', { quality: { general: 88 }, multiplierPpm: 800_000 }),
      makeSnapshot('p1:m-d', { quality: { general: 70 }, multiplierPpm: 800_000 }),
      makeSnapshot('p1:m-e', { quality: { general: 95 }, multiplierPpm: 800_000 }),
    ];
    // multiplier 最低 800_000 组：m-c(88)/m-d(70)/m-e(95)；quality 降序 → m-e 胜出
    const baseline = routeCreditFirst(makeFilterInput(snaps), 'general', 75).selected.routeId;
    expect(baseline).toBe('p1:m-e');
    for (let seed = 1; seed <= 50; seed++) {
      const shuffled = shuffle(snaps, mulberry32(seed));
      const selected = routeCreditFirst(makeFilterInput(shuffled), 'general', 75).selected.routeId;
      expect(selected).toBe(baseline);
    }
  });
});

// ===== fail closed 验证 =====

describe('fail closed 验证', () => {
  it('无权限的模型不被选中', () => {
    // m-noaccess 不在全局默认 → access denied；m-ok 有权限
    // m-noaccess 质量更高，但仍应被排除
    const sNo = makeSnapshot('p1:m-noaccess', { quality: { general: 99 }, multiplierPpm: 100_000 });
    const sOk = makeSnapshot('p1:m-ok', { quality: { general: 70 }, multiplierPpm: 100_000 });
    const result = routeQualityFirst(
      makeFilterInput([sNo, sOk], { globalDefault: new Set(['p1:m-ok']) }),
      'general',
    );
    expect(result.selected.routeId).toBe('p1:m-ok');
    expect(exclusionReason(result.decision.excluded, 'p1:m-noaccess')).toBe('access_denied');
  });

  it('额度耗尽（quotaCheck 返回 false）的模型不被选中', () => {
    const sQuota = makeSnapshot('p1:m-quota', { quality: { general: 99 }, multiplierPpm: 100_000 });
    const sOk = makeSnapshot('p1:m-ok', { quality: { general: 70 }, multiplierPpm: 100_000 });
    const result = routeQualityFirst(
      makeFilterInput([sQuota, sOk], { quotaCheck: (r) => r !== 'p1:m-quota' }),
      'general',
    );
    expect(result.selected.routeId).toBe('p1:m-ok');
    expect(exclusionReason(result.decision.excluded, 'p1:m-quota')).toBe('quota_exceeded');
  });

  it('缺能力的模型不被选中', () => {
    const sNoCap = makeSnapshot('p1:m-nocap', {
      quality: { general: 99 },
      multiplierPpm: 100_000,
      capabilities: [],
    });
    const sCap = makeSnapshot('p1:m-cap', {
      quality: { general: 70 },
      multiplierPpm: 100_000,
      capabilities: ['tool_use'],
    });
    const result = routeQualityFirst(
      makeFilterInput([sNoCap, sCap], { requiredCapabilities: ['tool_use'] }),
      'general',
    );
    expect(result.selected.routeId).toBe('p1:m-cap');
    expect(exclusionReason(result.decision.excluded, 'p1:m-nocap')).toBe(
      'capability_not_supported',
    );
  });

  it('质量不达标（低于 minimum_quality）的模型不被选中', () => {
    const sBelow = makeSnapshot('p1:m-below', { quality: { general: 60 }, multiplierPpm: 100_000 });
    const sAbove = makeSnapshot('p1:m-above', { quality: { general: 90 }, multiplierPpm: 500_000 });
    const result = routeCreditFirst(makeFilterInput([sBelow, sAbove]), 'general', 75);
    expect(result.selected.routeId).toBe('p1:m-above');
    expect(exclusionReason(result.decision.excluded, 'p1:m-below')).toBe('quality_missing');
  });
});
