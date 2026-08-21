/**
 * GOV-TRACE-002 / GOV-SELECT-001 / GOV-UI-001：Client 侧注册对象的单元测试。
 *
 * SEAM-5：浏览器 bundle 无法在 Node 实例化，因此这里直接测试注册对象的
 * 纯逻辑（match/start/update/buildViewNode、视图构建器、selector 注入面、
 * registerClientSurface 接线），运行时挂载验证随 B-3 浏览器 E2E 交付。
 */
import { describe, expect, it } from 'vitest';
import {
  GOVERNOR_CARD_LABELS,
  governorDecisionViewDefinition,
  governorModelSeatSpec,
  governorSettingsSection,
  governorTrajectoryDefinition,
  registerClientSurface,
} from '../../src/plugin/client-registration.js';
import type { GovernorService } from '../../src/plugin/service.js';
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationViewNode,
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

/** 构造 start 的 match 参数（start 只读 match.event）。 */
function matchOf(event: { type: string; data: unknown }): ConversationMatch {
  return { event, role: 'start', location: { kind: 'session' } } as unknown as ConversationMatch;
}

/** 构造 buildViewNode 的 context 参数。 */
function contextOf(state: unknown): ConversationNodeContext<unknown> {
  return { state } as unknown as ConversationNodeContext<unknown>;
}

describe('GOV-TRACE-002 Trajectory 卡片 Definition', () => {
  it('match：非 governor 事件返回 null，governor 事件返回 decisionId 身份', () => {
    expect(governorTrajectoryDefinition.match({ type: 'turn/start', data: {} })).toBeNull();
    expect(governorTrajectoryDefinition.match({ type: 'user/message', data: {} })).toBeNull();
    const matched = governorTrajectoryDefinition.match(decisionEvent());
    expect(matched).toEqual({ id: 'req-1:0', role: 'start' });
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

  it('buildViewNode：产出卡片视图节点（key/kind/id/target + 摘要与抽屉数据）', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent()),
    );
    const node = governorTrajectoryDefinition.buildViewNode(contextOf(state));
    expect(node).toMatchObject({
      key: 'governor-routing-decision:req-1:0',
      kind: 'governor-routing-decision',
      id: 'req-1:0',
      target: 'governor-decision',
    });
    const data = node!.data as {
      summary: Record<string, unknown>;
      detail: Record<string, unknown>;
    };
    // 摘要：选择模式、所选路由、策略、倍率/质量取自候选首位
    expect(data.summary['selectionMode']).toBe('auto');
    expect(data.summary['selectedRoute']).toBe('p:best');
    expect(data.summary['effectiveStrategy']).toBe('quality_first');
    expect(data.summary['multiplierPpm']).toBe(1_200_000);
    expect(data.summary['quality']).toBe(90);
    expect(data.summary['reason']).toBe('initial');
    // 抽屉：候选排序、排除原因、分类、revision
    expect(data.detail['candidates']).toHaveLength(2);
    expect(data.detail['excluded']).toEqual([{ routeId: 'p:off', reason: 'disabled' }]);
    expect(data.detail['configRevision']).toBe(5);
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
    const data = node!.data as { summary: Record<string, unknown> };
    expect(data.summary['outcome']).toBe('rejected');
    expect(data.summary['errorCode']).toBe('NO_MODEL_MATCHED');
    expect(data.summary['reason']).toBe('fallback, config_change, NO_MODEL_MATCHED');
    expect(data.summary['selectedRoute']).toBeNull();
    expect(data.summary['multiplierPpm']).toBeNull();
    expect(governorTrajectoryDefinition.buildViewNode(contextOf(undefined))).toBeNull();
  });

  it('buildViewNode：所选路由不在候选首位时倍率/质量显示未知（null）', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent({ selectedRoute: 'p:other' })),
    );
    const node = governorTrajectoryDefinition.buildViewNode(contextOf(state));
    const data = node!.data as { summary: Record<string, unknown> };
    expect(data.summary['multiplierPpm']).toBeNull();
    expect(data.summary['quality']).toBeNull();
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

describe('GOV-TRACE-002 governor-decision 视图构建器', () => {
  /** 构造一个卡片视图节点。 */
  function nodeOf(id: string): ConversationViewNode {
    return {
      key: `governor-routing-decision:${id}`,
      kind: 'governor-routing-decision',
      id,
      target: 'governor-decision',
      data: { summary: {}, detail: {} },
    };
  }

  it('target 为 governor-decision；create 返回带空快照的增量构建器', () => {
    expect(governorDecisionViewDefinition.target).toBe('governor-decision');
    const builder = governorDecisionViewDefinition.create();
    expect(builder.empty).toEqual({ nodes: [], turnOrder: [] });
  });

  it('replace：全量替换节点集与 turn 顺序', () => {
    const builder = governorDecisionViewDefinition.create();
    const snapshot = builder.replace({
      nodes: [nodeOf('a'), nodeOf('b')],
      timeline: { turnOrder: [1, 2], turns: new Map() },
    });
    expect(snapshot.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(snapshot.turnOrder).toEqual([1, 2]);
  });

  it('apply：按 key 合并变更节点（新节点追加、同 key 覆盖）', () => {
    const builder = governorDecisionViewDefinition.create();
    builder.replace({
      nodes: [nodeOf('a'), nodeOf('b')],
      timeline: { turnOrder: [1], turns: new Map() },
    });
    const snapshot = builder.apply({
      upserts: [nodeOf('b'), nodeOf('c')],
      timeline: { turnOrder: [1, 2], turns: new Map() },
    });
    expect(snapshot.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(snapshot.turnOrder).toEqual([1, 2]);
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

describe('registerClientSurface 接线（SEAM-5：Node 安全跳过）', () => {
  /** 构造浏览器注册面 fake（模拟 ctx.get(name) 可选服务读取）。 */
  function browserRegistries() {
    const registered: { kind: string; payload: unknown }[] = [];
    const store: Record<string, unknown> = {
      conversationEvents: {
        registerFallback: (definition: unknown) => {
          registered.push({ kind: 'event', payload: definition });
          return () =>
            registered.splice(
              registered.findIndex((r) => r.kind === 'event'),
              1,
            );
        },
      },
      conversationViews: {
        register: (definition: unknown) => {
          registered.push({ kind: 'view', payload: definition });
          return () =>
            registered.splice(
              registered.findIndex((r) => r.kind === 'view'),
              1,
            );
        },
      },
      slots: {
        register: (spec: unknown, component: unknown) => {
          registered.push({ kind: 'slot', payload: { spec, component } });
          return () =>
            registered.splice(
              registered.findIndex((r) => r.kind === 'slot'),
              1,
            );
        },
      },
      settings: {
        section: (section: unknown) => {
          registered.push({ kind: 'settings', payload: section });
          return () =>
            registered.splice(
              registered.findIndex((r) => r.kind === 'settings'),
              1,
            );
        },
      },
    };
    return {
      registered,
      ctx: { get: (name: string) => store[name] },
    };
  }

  it('Host/Node 上下文（无注册面）安全跳过，返回空数组', () => {
    expect(registerClientSurface({})).toEqual([]);
    expect(registerClientSurface(undefined)).toEqual([]);
    // 有 get 但服务未提供（Host/Node 的 Cordis 上下文）：同样跳过
    expect(registerClientSurface({ get: () => undefined })).toEqual([]);
  });

  it('浏览器注册面 + service + 组件齐备：注册全部四个面，disposer 逐项清理', () => {
    const { ctx, registered } = browserRegistries();
    const service = {
      getSessionSelectionMode: () => ({
        mode: 'auto' as const,
        selectionRevision: 1,
        isDefault: false,
      }),
      setSessionSelectionMode: async () => ({ mode: 'auto' as const, selectionRevision: 2 }),
    } as unknown as GovernorService;
    const component = { fake: 'component' };
    const disposers = registerClientSurface(ctx, { service, selectorComponent: component });
    expect(disposers).toHaveLength(4);
    expect(registered.map((r) => r.kind)).toEqual(['event', 'view', 'slot', 'settings']);
    // selector 注册携带 spec（座席名 + Host 方法接线）与浏览器组件
    const slot = registered.find((r) => r.kind === 'slot')!.payload as {
      spec: { name: string };
      component: unknown;
    };
    expect(slot.spec.name).toBe('conversation.input.model');
    expect(slot.component).toBe(component);
    // disposer 全部生效（HMR/卸载清理，GOV-UI-001 AC 7）
    for (const dispose of disposers) dispose();
    expect(registered).toEqual([]);
  });

  it('浏览器注册面但缺组件：不注册 selector（不以假组件抢占官方 occupant）', () => {
    const { ctx, registered } = browserRegistries();
    const service = {
      getSessionSelectionMode: () => ({
        mode: 'auto' as const,
        selectionRevision: 1,
        isDefault: false,
      }),
      setSessionSelectionMode: async () => ({ mode: 'auto' as const, selectionRevision: 2 }),
    } as unknown as GovernorService;
    const disposers = registerClientSurface(ctx, { service });
    expect(disposers).toHaveLength(3);
    expect(registered.map((r) => r.kind)).toEqual(['event', 'view', 'settings']);
  });

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
    expect((node!.data as { summary: Record<string, unknown> }).summary['reason']).toBe('fallback');
  });

  it('trigger 与 cause 重复时原因摘要只保留一次', () => {
    const state = governorTrajectoryDefinition.start(
      contextOf(undefined),
      matchOf(decisionEvent({ trigger: 'step', causes: ['step', 'resume'] })),
    );
    const node = governorTrajectoryDefinition.buildViewNode(contextOf(state));
    expect((node!.data as { summary: Record<string, unknown> }).summary['reason']).toBe(
      'step, resume',
    );
  });
});
