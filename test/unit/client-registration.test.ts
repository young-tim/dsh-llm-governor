/**
 * GOV-TRACE-002 / GOV-SELECT-001 / GOV-UI-001 的共享契约单测。
 * 真实 `dsh.client` bundle 及挂载/HMR/卸载在 contracts 与 ui 项目另行验证。
 */
import { describe, expect, it } from 'vitest';
import {
  GOVERNOR_CARD_LABELS,
  governorModelSeatSpec,
  governorSettingsSection,
  governorTrajectoryDefinition,
} from '../../src/plugin/client-registration.js';
import type { GovernorService } from '../../src/plugin/service.js';
import type {
  ConversationMatch,
  ConversationNodeContext,
} from '@deepseek-ai/dsh-client-runtime/client';

/** 构造一条 governor/routing-decision 事件（字段完整）。 */
function decisionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'governor/routing-decision',
    seq: 42,
    data: {
      schemaVersion: 1,
      decisionId: 'req-1:0',
      decisionHash: 'abc',
      requestId: 'req-1',
      turn: 3,
      step: 2,
      fallbackIndex: 0,
      trigger: 'initial',
      causes: ['initial'],
      changedFields: [],
      selectionMode: 'auto',
      effectiveStrategy: 'quality_first',
      classification: { taskType: 'coding', complexity: 'high', confidence: 0.9, source: 'llm' },
      minimumQuality: 80,
      candidates: [
        { routeId: 'p:best', quality: 90, multiplierPpm: 1_200_000 },
        { routeId: 'p:cheap', quality: 70, multiplierPpm: 500_000 },
      ],
      excluded: [{ routeId: 'p:off', reason: 'disabled' }],
      outcome: 'selected',
      selectedRoute: 'p:best',
      configRevision: 5,
      occurredAt: 1_700_000_000_000,
      ...overrides,
    },
  };
}

/** 将同一决策放入 rc.8 冷恢复兼容的 request/context carrier。 */
function decisionCarrier(overrides: Record<string, unknown> = {}) {
  const legacy = decisionEvent(overrides);
  return {
    type: 'request/context',
    seq: legacy.seq,
    data: {
      provider: 'p',
      model: 'best',
      governorDecision: legacy.data,
    },
  };
}

/** 构造 start 的 match 参数（start 只读 match.event）。 */
function matchOf(event: { type: string; data: unknown }): ConversationMatch {
  return { event, role: 'start', location: { kind: 'session' } } as unknown as ConversationMatch;
}

/** 构造 buildViewNode 的 context 参数。 */
function contextOf(state: unknown): ConversationNodeContext<unknown> {
  const decisionId =
    typeof state === 'object' && state !== null && 'decisionId' in state
      ? String((state as { decisionId: unknown }).decisionId)
      : 'unknown';
  const kind = 'governor-routing-decision';
  const start = matchOf(decisionEvent());
  return {
    key: `${kind.length}:${kind}${decisionId}`,
    kind,
    id: decisionId,
    matches: [start],
    start,
    state,
    current: new Map(),
  } as ConversationNodeContext<unknown>;
}

function markdownOf(node: { readonly data: unknown }): string {
  const data = node.data as {
    kind: 'node';
    node: { kind: 'context'; content: Array<{ type: string; text: string }> };
  };
  expect(data.kind).toBe('node');
  expect(data.node.kind).toBe('context');
  return data.node.content[0]!.text;
}

describe('GOV-TRACE-002 Trajectory 卡片 Definition', () => {
  it('match：非 governor 事件返回 null，governor 事件返回 decisionId 身份', () => {
    expect(governorTrajectoryDefinition.match({ type: 'turn/start', data: {} })).toBeNull();
    expect(governorTrajectoryDefinition.match({ type: 'user/message', data: {} })).toBeNull();
    const matched = governorTrajectoryDefinition.match(decisionEvent());
    expect(matched).toEqual({ id: 'req-1:0', role: 'start' });
  });

  it('request/context.governorDecision carrier 与 legacy envelope 构建同一轨迹卡片', () => {
    expect(governorTrajectoryDefinition.match(decisionCarrier())).toEqual({
      id: 'req-1:0',
      role: 'start',
    });
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionCarrier()),
    ) as unknown as Record<string, unknown>;
    expect(state).toMatchObject({
      decisionId: 'req-1:0',
      selectedRoute: 'p:best',
      selectionMode: 'auto',
    });
  });

  it('match：损坏事件缺 decisionId 时回退事件 seq（卡片仍可挂载）', () => {
    const matched = governorTrajectoryDefinition.match({
      type: 'governor/routing-decision',
      seq: 7,
      data: {},
    });
    expect(matched).toEqual({ id: 'seq-7', role: 'start' });
    expect(
      governorTrajectoryDefinition.match({ type: 'governor/routing-decision', data: {} }),
    ).toEqual({ id: 'unknown', role: 'start' });
  });

  it('start：完整事件构建完整状态（selected 路由、分类、候选与排除）', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent()),
    ) as ReturnType<typeof Object>;
    const s = state as Record<string, unknown>;
    expect(s['decisionId']).toBe('req-1:0');
    expect(s['selectionMode']).toBe('auto');
    expect(s['effectiveStrategy']).toBe('quality_first');
    expect(s['outcome']).toBe('selected');
    expect(s['selectedRoute']).toBe('p:best');
    expect(s['classification']).toEqual({
      taskType: 'coding',
      complexity: 'high',
      confidence: 0.9,
      source: 'llm',
    });
    expect(s['candidates']).toEqual([
      { routeId: 'p:best', quality: 90, multiplierPpm: 1_200_000 },
      { routeId: 'p:cheap', quality: 70, multiplierPpm: 500_000 },
    ]);
    expect(s['excluded']).toEqual([{ routeId: 'p:off', reason: 'disabled' }]);
    expect(s['configRevision']).toBe(5);
  });

  it('start：旧 schema/缺失字段 → unknown/null，不伪造值（AC 5）', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf({ type: 'governor/routing-decision', data: { schemaVersion: 1 } }),
    ) as unknown as Record<string, unknown>;
    expect(state['decisionId']).toBe('unknown');
    expect(state['selectionMode']).toBe('unknown');
    expect(state['effectiveStrategy']).toBe('unknown');
    expect(state['outcome']).toBe('unknown');
    expect(state['errorCode']).toBeNull();
    expect(state['turn']).toBeNull();
    expect(state['classification']).toBeNull();
    expect(state['candidates']).toEqual([]);
    expect(state['excluded']).toEqual([]);
    expect(state['configRevision']).toBeNull();
    // 非法枚举值同样降级为 unknown
    const bad = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent({ selectionMode: 'AUTO', outcome: 42, classification: 'nope' })),
    ) as unknown as Record<string, unknown>;
    expect(bad['selectionMode']).toBe('unknown');
    expect(bad['outcome']).toBe('unknown');
    expect(bad['classification']).toBeNull();
  });

  it('start：事件类型不符时抛错（防御：引擎契约破坏时 fail loud）', () => {
    expect(() =>
      governorTrajectoryDefinition.start(
        contextOf(undefined),
        matchOf({ type: 'turn/start', data: {} }),
      ),
    ).toThrow('GOVERNOR_CARD_STATE');
  });

  it('update：决策事件自包含，update 恒返回既有状态', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent()),
    );
    expect(governorTrajectoryDefinition.update({ state } as never, matchOf(decisionEvent()))).toBe(
      state,
    );
  });

  it('buildViewNode：将完整决策投影进官方 trajectory 的 context notice', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent()),
    );
    const node = governorTrajectoryDefinition.buildViewNode(contextOf(state));
    expect(node).toMatchObject({
      key: '25:governor-routing-decisionreq-1:0',
      kind: 'governor-routing-decision',
      id: 'req-1:0',
      target: 'trajectory',
      anchorSeq: 42,
      location: { kind: 'session' },
    });
    const markdown = markdownOf(node!);
    expect(markdown).toContain('Governor 路由 · Turn 3 · Step 2');
    expect(markdown).toContain('模式：自动选择 · 策略：质量优先');
    expect(markdown).toContain('模型：p:best · Quality：90 · 倍率：×1.2');
    expect(markdown).toContain('p:cheap · Q 70 · ×0.5');
    expect(markdown).toContain('p:off · 模型已禁用 (disabled)');
    expect(markdown).toContain('Revision：5');
  });

  it('buildViewNode：rejected 决策的原因摘要附带错误码；state 缺失返回 null', () => {
    const rejected = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(
        decisionEvent({
          outcome: 'rejected',
          errorCode: 'NO_MODEL_MATCHED',
          trigger: 'fallback',
          causes: ['fallback', 'config_change'],
          candidates: [],
          selectedRoute: undefined,
        }),
      ),
    );
    const node = governorTrajectoryDefinition.buildViewNode(contextOf(rejected));
    const markdown = markdownOf(node!);
    expect(markdown).toContain('状态：已拒绝');
    expect(markdown).toContain('模型：未选择 · Quality：未知 · 倍率：×未知');
    expect(markdown).toContain(
      '原因：Fallback 重试 (fallback)、配置变更 (config_change)、没有匹配模型 (NO_MODEL_MATCHED)',
    );
    expect(governorTrajectoryDefinition.buildViewNode(contextOf(undefined))).toBeNull();
  });

  it('buildViewNode：Quality 缺失时在官方轨迹给出可操作的快速初始化指引', () => {
    const rejected = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(
        decisionEvent({
          outcome: 'rejected',
          errorCode: 'NO_MODEL_MATCHED',
          candidates: [],
          selectedRoute: undefined,
          classification: {
            taskType: 'general',
            complexity: 'medium',
            confidence: 0,
            source: 'rule',
          },
          excluded: [{ routeId: 'p:missing', reason: 'quality_missing' }],
        }),
      ),
    );
    const markdown = markdownOf(governorTrajectoryDefinition.buildViewNode(contextOf(rejected))!);
    expect(markdown).toContain('Settings → Governor → 模型');
    expect(markdown).toContain('Lite 75 / 均衡 85 / Pro 95');
    expect(markdown).toContain('当前缺少 **general** Quality');
  });

  it('buildViewNode：所选路由不在候选首位时倍率/质量显示未知（null）', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent({ selectedRoute: 'p:other' })),
    );
    const node = governorTrajectoryDefinition.buildViewNode(contextOf(state));
    expect(markdownOf(node!)).toContain('模型：p:other · Quality：未知 · 倍率：×未知');
  });

  it('卡片文案资源：中英文标签覆盖全部枚举（AC 2，不把内部枚举当 UI 文案）', () => {
    for (const locale of ['zh', 'en'] as const) {
      const labels = GOVERNOR_CARD_LABELS[locale];
      expect(Object.keys(labels.selectionMode).sort()).toEqual(['auto', 'manual', 'unknown']);
      expect(Object.keys(labels.strategy).sort()).toEqual([
        'credit_first',
        'manual',
        'quality_first',
        'unknown',
      ]);
      expect(Object.keys(labels.outcome).sort()).toEqual(['rejected', 'selected', 'unknown']);
    }
  });
});

describe('GOV-SELECT-001 Composer Auto selector 注册', () => {
  /** 构造只含 selector 所需方法面的 fake service。 */
  function fakeService(overrides: {
    mode?: 'auto' | 'manual';
    lastManualRoute?: string;
    calls?: Array<{ sessionId: string; mode: 'auto' | 'manual' }>;
  }) {
    return {
      getSessionSelectionMode: (sessionId: string) => ({
        mode: overrides.mode ?? 'manual',
        selectionRevision: 3,
        isDefault: false,
        ...(overrides.lastManualRoute !== undefined
          ? { lastManualRoute: overrides.lastManualRoute }
          : {}),
        sessionId,
      }),
      setSessionSelectionMode: async (sessionId: string, mode: 'auto' | 'manual') => {
        overrides.calls?.push({ sessionId, mode });
        return { mode, selectionRevision: 4 };
      },
    } as unknown as GovernorService;
  }

  it('spec：座席名为 conversation.input.model，置顶选项不伪造成 Provider 模型', () => {
    const spec = governorModelSeatSpec(fakeService({}));
    expect(spec.name).toBe('conversation.input.model');
    expect(spec.label).toBe('自动（Governor）');
  });

  it('inject：暴露当前模式与最近手动路由；selectAuto 调用 Host 同一方法（AC 7）', async () => {
    const calls: Array<{ sessionId: string; mode: 'auto' | 'manual' }> = [];
    const service = fakeService({ mode: 'manual', lastManualRoute: 'p:m', calls });
    const spec = governorModelSeatSpec(service);
    const injected = spec.inject('sess-1');
    expect(injected.available).toBe(true);
    expect(injected.selectionMode).toBe('manual');
    expect(injected.lastManualRoute).toBe('p:m');
    const result = await injected.selectAuto();
    expect(result).toEqual({ mode: 'auto', selectionRevision: 4 });
    expect(calls).toEqual([{ sessionId: 'sess-1', mode: 'auto' }]);
  });

  it('inject：无手动路由历史时 lastManualRoute 为 null', () => {
    const service = fakeService({ mode: 'auto' });
    const injected = governorModelSeatSpec(service).inject('sess-2');
    expect(injected.selectionMode).toBe('auto');
    expect(injected.lastManualRoute).toBeNull();
  });
});

describe('浏览器注册共享契约', () => {
  it('Settings 分区声明：P0 范围四分区，usage 只读（GOV-UI-001）', () => {
    expect(governorSettingsSection.name).toBe('governor');
    expect(
      governorSettingsSection.sections.map((s) => `${s.key}:${s.readOnly ? 'ro' : 'rw'}`),
    ).toEqual(['routing:rw', 'models:rw', 'users:rw', 'usage:ro']);
  });
});

describe('卡片视图数据（防御性解析的补充分支）', () => {
  it('候选/排除条目缺字段时显示 unknown，cause 混入非字符串被过滤', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(
        decisionEvent({
          candidates: [{ routeId: 'p:best' }, null, 42],
          excluded: [{}],
          causes: ['fallback', 42],
          trigger: undefined,
          changedFields: [7, 'strategy'],
        }),
      ),
    ) as unknown as Record<string, unknown>;
    // 候选/排除条目缺字段或非对象 → 各字段显示 unknown（不丢条目）
    expect(state['candidates']).toEqual([
      { routeId: 'p:best', quality: null, multiplierPpm: null },
      { routeId: 'unknown', quality: null, multiplierPpm: null },
      { routeId: 'unknown', quality: null, multiplierPpm: null },
    ]);
    expect(state['excluded']).toEqual([{ routeId: 'unknown', reason: 'unknown' }]);
    // causes/changedFields 中的非字符串被过滤
    expect(state['causes']).toEqual(['fallback']);
    expect(state['changedFields']).toEqual(['strategy']);
    // trigger 缺失时原因由存活 causes 提供（'fallback'），无错误码附加
    const node = governorTrajectoryDefinition.buildViewNode(contextOf(state));
    expect(markdownOf(node!)).toContain('原因：Fallback 重试 (fallback)');
  });

  it('trigger 与 cause 重复时原因摘要只保留一次', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent({ trigger: 'step', causes: ['step', 'resume'] })),
    );
    const node = governorTrajectoryDefinition.buildViewNode(contextOf(state));
    expect(markdownOf(node!)).toContain('原因：新步骤 (step)、resume');
  });
});
