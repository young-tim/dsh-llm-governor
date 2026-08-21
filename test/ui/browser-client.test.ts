/** Real Governor browser-entry lifecycle and rendered-control tests. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client';
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots';
import {
  apply,
  GovernorModelSelect,
  GovernorSettings,
  createGovernorClientApi,
  type GovernorClientApi,
  type GovernorModelView,
  type GovernorRemoteFace,
  type GovernorRoutingView,
  type GovernorUserView,
  type GovernorUsageView,
} from '../../src/client/index.js';

type Dispose = () => void | Promise<void>;

const slotKeys = ['conversation.view', 'conversation.input.model', 'settings.section'] as const;

function OfficialModelSelect() {
  return null;
}

/** rc.8 SlotCore plus the runtime wrapper's declaration-inject behavior. */
class SlotLedger {
  private readonly core = new SlotCore();
  private readonly controllers = new Map<
    string,
    Set<{ callback: () => Dispose; active?: Dispose }>
  >();

  inject = (key: string, callback: () => Dispose): Dispose => {
    const controller: { callback: () => Dispose; active?: Dispose } = { callback };
    const group = this.controllers.get(key) ?? new Set();
    group.add(controller);
    this.controllers.set(key, group);
    const refresh = () => {
      if (this.core.specDynamic(key) !== undefined && controller.active === undefined) {
        controller.active = callback();
      } else if (this.core.specDynamic(key) === undefined && controller.active !== undefined) {
        controller.active();
        controller.active = undefined;
      }
    };
    const unsubscribe = this.core.subscribeDeclaration(key, refresh);
    try {
      refresh();
    } catch (error) {
      unsubscribe();
      group.delete(controller);
      throw error;
    }
    return () => {
      controller.active?.();
      controller.active = undefined;
      unsubscribe();
      group.delete(controller);
    };
  };

  register = (spec: Record<string, unknown>, component: unknown): Dispose =>
    this.core.register({ ...spec, registrant: 'dsh-llm-governor' } as never, component as never);

  declareOfficialSurfaces(): Dispose {
    const disposeOwner = this.core.register(
      {
        name: 'root',
        registrant: 'official-shell',
        children: {
          'conversation.view': { kind: 'list', scope: 'session' },
          'conversation.input.model': { kind: 'single', scope: 'session' },
          'settings.section': { kind: 'list', scope: 'root' },
        },
      } as never,
      (() => null) as never,
    );
    const official: Dispose[] = [
      this.core.register(
        {
          name: 'conversation.view',
          id: 'chat',
          registrant: 'official-conversation',
        } as never,
        (() => null) as never,
      ),
      this.core.register(
        {
          name: 'conversation.input.model',
          registrant: 'official-model-selection',
        } as never,
        OfficialModelSelect as never,
      ),
      this.core.register(
        {
          name: 'settings.section',
          id: 'general',
          registrant: 'official-settings',
        } as never,
        (() => null) as never,
      ),
    ];
    return () => {
      for (const dispose of official.reverse()) dispose();
      disposeOwner();
    };
  }

  governor(key?: string): StoredEntry[] {
    const keys: readonly string[] = key === undefined ? slotKeys : [key];
    return keys.flatMap((slot) =>
      this.core.entries(slot).filter((entry) => entry.registrant === 'dsh-llm-governor'),
    );
  }

  officialCount(): number {
    return slotKeys
      .flatMap((key) => this.core.entries(key))
      .filter((entry) => entry.registrant?.startsWith('official-')).length;
  }

  modelWinner(): StoredEntry | undefined {
    return this.core.entriesOfSlot('conversation.input.model')[0];
  }

  pending(): number {
    return [...this.controllers.values()].reduce((sum, group) => sum + group.size, 0);
  }
}

function success<T>(value: T) {
  return Promise.resolve({ ok: true as const, value });
}

function remoteFace(): GovernorRemoteFace {
  const routing: GovernorRoutingView = {
    default: 'quality_first',
    creditFirst: { minimumQuality: 70, onNoMatch: 'quality_first' },
    auto: {
      confidenceThreshold: 0.7,
      qualityThreshold: { low: 45, medium: 70, high: 85 },
    },
    fallback: {
      enabled: true,
      maxAttempts: 2,
      afterPartialOutput: false,
      strategy: 'quality_first',
    },
    configRevision: 3,
  };
  return {
    describeAccess: () => success({ actorId: 'owner', capabilities: ['governor.manage'] }),
    listModels: () => success([]),
    updateModel: (_routeId, _patch) =>
      success({
        routeId: 'p:a',
        provider: 'p',
        model: 'a',
        enabled: true,
        multiplierPpm: 1_000_000,
        capabilities: [],
        quality: {},
        configRevision: 4,
      }),
    listUsers: () => success([]),
    updateUser: (userId, patch) =>
      success({
        userId,
        allow: [],
        monthlyCredits: patch.monthlyCredits ?? 0,
        configRevision: 4,
      }),
    getRouting: () => success(routing),
    updateRouting: () => success(routing),
    queryUsage: () => success([]),
    getSessionSelectionMode: () =>
      success({ mode: 'manual' as const, selectionRevision: 1, lastManualRoute: 'p:a' }),
    setSessionSelectionMode: (_sessionId, mode) =>
      success({ mode, selectionRevision: 2, lastManualRoute: 'p:a' }),
    explainDecision: () => success([]),
    listAuditEntries: () => success([]),
  };
}

function browserHarness(slots = new SlotLedger()) {
  const eventDefinitions: unknown[] = [];
  let mounts = 0;
  let unmounts = 0;
  const governor = remoteFace();
  const remote = {
    $mount: vi.fn(async () => {
      mounts += 1;
      return async () => {
        unmounts += 1;
      };
    }),
  };
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      current: null,
      routable: true,
      groups: [],
      failures: [],
      status: 'ready' as const,
      error: null,
    }),
  };
  const loadDirectory = vi.fn(async () => {});
  const selectDirectory = vi.fn(async () => {});
  const ctx = {
    get: vi.fn((name: string) => (name === 'remote.governor' ? governor : undefined)),
    remote,
    slots,
    sessions: { subagentAddress: (_sessionId: SessionId) => undefined as string | undefined },
    modelDirectories: {
      directoryFor: () => ({ store, load: loadDirectory, select: selectDirectory }),
    },
    conversationEvents: {
      register: (definition: unknown) => {
        eventDefinitions.push(definition);
        return () => eventDefinitions.splice(eventDefinitions.indexOf(definition), 1);
      },
    },
  };
  return {
    ctx,
    slots,
    eventDefinitions,
    remote,
    loadDirectory,
    selectDirectory,
    counts: () => ({ mounts, unmounts }),
  };
}

describe('dsh.client lifecycle', () => {
  it.each(['official-first', 'governor-first'] as const)(
    '%s: two Governor surfaces mount and unload restores official occupants',
    async (order) => {
      const harness = browserHarness();
      let disposeDeclaration: Dispose | undefined;
      if (order === 'official-first') disposeDeclaration = harness.slots.declareOfficialSurfaces();
      const dispose = await apply(harness.ctx as never);
      if (order === 'governor-first') disposeDeclaration = harness.slots.declareOfficialSurfaces();

      expect(harness.eventDefinitions).toHaveLength(1);
      expect(
        harness.slots
          .governor()
          .map((record) => record.options)
          .map((options) => options.id ?? 'conversation.input.model')
          .sort(),
      ).toEqual(['conversation.input.model', 'governor'].sort());
      expect(harness.remote.$mount).toHaveBeenCalledTimes(1);
      expect(harness.slots.modelWinner()?.component).toBe(GovernorModelSelect);
      expect(harness.slots.modelWinner()?.options.priority).toBe(-10);
      await dispose();

      expect(harness.eventDefinitions).toHaveLength(0);
      expect(harness.slots.governor()).toHaveLength(0);
      expect(harness.slots.officialCount()).toBe(3);
      expect(harness.slots.modelWinner()?.component).toBe(OfficialModelSelect);
      expect(harness.slots.pending()).toBe(0);
      expect(harness.counts()).toEqual({ mounts: 1, unmounts: 1 });
      await disposeDeclaration?.();
    },
  );

  it('10 HMR cycles remain duplicate-free and dispose Typert + every registration', async () => {
    const harness = browserHarness();
    const disposeDeclaration = harness.slots.declareOfficialSurfaces();
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const dispose = await apply(harness.ctx as never);
      expect(harness.slots.governor()).toHaveLength(2);
      expect(harness.eventDefinitions).toHaveLength(1);
      expect(harness.slots.modelWinner()?.component).toBe(GovernorModelSelect);
      await dispose();
      await dispose();
      expect(harness.slots.governor()).toHaveLength(0);
      expect(harness.eventDefinitions).toHaveLength(0);
      expect(harness.slots.pending()).toBe(0);
      expect(harness.slots.modelWinner()?.component).toBe(OfficialModelSelect);
    }
    expect(harness.counts()).toEqual({ mounts: 10, unmounts: 10 });
    await disposeDeclaration();
  });

  it('partial setup failure unwinds mounted Remote and earlier definitions', async () => {
    const harness = browserHarness();
    harness.ctx.conversationEvents.register = () => {
      throw new Error('EVENT_REGISTRATION_FAILED');
    };
    await expect(apply(harness.ctx as never)).rejects.toThrow('EVENT_REGISTRATION_FAILED');
    expect(harness.eventDefinitions).toHaveLength(0);
    expect(harness.slots.governor()).toHaveLength(0);
    expect(harness.counts()).toEqual({ mounts: 1, unmounts: 1 });
  });

  it('missing dynamic Remote namespace fails loud and unwinds its mount', async () => {
    const harness = browserHarness();
    harness.ctx.get.mockReturnValue(undefined);
    await expect(apply(harness.ctx as never)).rejects.toThrow(
      'Governor Remote namespace did not become available after mount',
    );
    expect(harness.counts()).toEqual({ mounts: 1, unmounts: 1 });
    expect(harness.slots.governor()).toHaveLength(0);
  });

  it('registered inject faces keep native directory behavior and slot labels live', async () => {
    const harness = browserHarness();
    const disposeDeclaration = harness.slots.declareOfficialSurfaces();
    const dispose = await apply(harness.ctx as never);
    const settings = harness.slots.governor('settings.section')[0]!;
    const model = harness.slots.governor('conversation.input.model')[0]!;
    expect(harness.slots.governor('conversation.view')).toHaveLength(0);
    expect((settings.options.label as () => string)()).toBe('Governor');
    expect(settings.inject?.()).toHaveProperty('api');

    const face = model.inject?.('session-face' as SessionId) as {
      available: boolean;
      load(): void;
      selectModel(selection: { provider: string; model: string }): Promise<boolean>;
    };
    expect(face.available).toBe(true);
    face.load();
    await expect(face.selectModel({ provider: 'p', model: 'a' })).resolves.toBe(true);
    expect(harness.loadDirectory).toHaveBeenCalledTimes(1);
    expect(harness.selectDirectory).toHaveBeenCalledTimes(1);

    harness.loadDirectory.mockRejectedValueOnce(new Error('LOAD_REJECTED'));
    harness.selectDirectory.mockRejectedValueOnce(new Error('SELECT_REJECTED'));
    const rejectedFace = model.inject?.('session-rejected' as SessionId) as typeof face;
    rejectedFace.load();
    await expect(rejectedFace.selectModel({ provider: 'p', model: 'a' })).resolves.toBe(false);
    await Promise.resolve();

    harness.ctx.sessions.subagentAddress = () => 'parent/subagent';
    const subagent = model.inject?.('session-subagent' as SessionId) as typeof face;
    expect(subagent.available).toBe(false);
    subagent.load();
    await expect(subagent.selectModel({ provider: 'p', model: 'a' })).resolves.toBe(false);
    expect(harness.loadDirectory).toHaveBeenCalledTimes(2);
    await dispose();
    await disposeDeclaration();
  });

  it('browser CSS installs once and is removed by the client disposer', async () => {
    const remove = vi.fn();
    const append = vi.fn();
    const tag = { dataset: {} as Record<string, string>, textContent: '', remove };
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => tag),
      head: { append },
    });
    const harness = browserHarness();
    const disposeDeclaration = harness.slots.declareOfficialSurfaces();
    const dispose = await apply(harness.ctx as never);
    expect(append).toHaveBeenCalledWith(tag);
    expect(tag.dataset).toMatchObject({
      plugin: 'dsh-llm-governor',
      pluginCss: 'dsh-llm-governor',
    });
    expect(tag.textContent).toContain('.dsh-governor-settings');
    await dispose();
    expect(remove).toHaveBeenCalledTimes(1);
    await disposeDeclaration();

    const existing = browserHarness();
    const existingDeclaration = existing.slots.declareOfficialSurfaces();
    (document.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(tag);
    const disposeExisting = await apply(existing.ctx as never);
    expect(append).toHaveBeenCalledTimes(1);
    await disposeExisting();
    await existingDeclaration();
    vi.unstubAllGlobals();
  });
});

function modelStore() {
  const snapshot = {
    current: { provider: 'p', model: 'a', reasoningEffort: 'medium' },
    routable: true,
    groups: [
      {
        id: 'p',
        name: 'Provider P',
        models: [
          {
            id: 'a',
            name: 'Alpha',
            reasoning: {
              defaultEffort: 'medium',
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'medium', name: 'Medium' },
                { id: 'high', name: 'High' },
              ],
            },
          },
          { id: 'b', name: 'Beta' },
        ],
      },
    ],
    failures: [],
    status: 'ready' as const,
    error: null,
  };
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  };
}

function emptySettingsApi(overrides: Partial<GovernorClientApi> = {}): GovernorClientApi {
  const routing: GovernorRoutingView = {
    default: 'quality_first',
    creditFirst: { minimumQuality: 70, onNoMatch: 'quality_first' },
    auto: {
      confidenceThreshold: 0.7,
      qualityThreshold: { low: 45, medium: 70, high: 85 },
    },
    fallback: {
      enabled: true,
      maxAttempts: 2,
      afterPartialOutput: false,
      strategy: 'quality_first',
    },
    configRevision: 1,
  };
  return {
    access: async () => ({
      actorId: 'owner',
      capabilities: ['governor.read', 'governor.manage'],
    }),
    selection: async () => ({ mode: 'manual', selectionRevision: 7 }),
    selectMode: async (_sessionId, mode) => ({ mode, selectionRevision: 8 }),
    routing: async () => routing,
    saveRouting: async () => routing,
    models: async () => [],
    saveModel: async () => {
      throw new Error('unused');
    },
    users: async () => [],
    saveUser: async () => {
      throw new Error('unused');
    },
    usage31Days: async () => [],
    ...overrides,
  };
}

describe('native rendered surfaces', () => {
  it('typed Remote adapter covers every read/write and preserves Host errors/options', async () => {
    const remote = remoteFace();
    const api = createGovernorClientApi(remote);
    const sessionId = 'adapter-session' as SessionId;
    await expect(api.access()).resolves.toMatchObject({ actorId: 'owner' });
    await expect(api.selection(sessionId)).resolves.toMatchObject({ mode: 'manual' });
    await expect(api.selectMode(sessionId, 'auto')).resolves.toMatchObject({ mode: 'auto' });
    await expect(api.routing()).resolves.toMatchObject({ default: 'quality_first' });
    await expect(api.saveRouting({ default: 'auto' })).resolves.toBeDefined();
    await expect(api.saveRouting({ default: 'manual' }, 3)).resolves.toBeDefined();
    await expect(api.models()).resolves.toEqual([]);
    await expect(api.saveModel('p:a', { enabled: false })).resolves.toMatchObject({
      routeId: 'p:a',
    });
    await expect(api.saveModel('p:a', { multiplier: 1.2 }, 3)).resolves.toBeDefined();
    await expect(api.users()).resolves.toEqual([]);
    await expect(api.saveUser('alice', { allow: ['p:a'] })).resolves.toMatchObject({
      userId: 'alice',
    });
    await expect(api.saveUser('alice', { monthlyCredits: 20 }, 3)).resolves.toBeDefined();

    const rejected = createGovernorClientApi({
      ...remote,
      listModels: async () => ({
        ok: false,
        error: { code: 'forbidden', message: '' },
      }),
    });
    await expect(rejected.models()).rejects.toThrow('forbidden: listModels');
  });

  it('Composer Auto calls Host setSessionSelectionMode with the current concrete route', async () => {
    const sessionId = 'session-1' as SessionId;
    const selectMode = vi.fn(async (_id: SessionId, mode: 'auto' | 'manual') => ({
      mode,
      selectionRevision: 8,
    }));
    const selectModel = vi.fn(async () => true);
    const api = emptySettingsApi({ selectMode });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(GovernorModelSelect, {
          locked: false,
          available: true,
          sessionId,
          directory: modelStore(),
          load: vi.fn(),
          selectModel,
          api,
        }),
      );
    });
    const modelSelect = renderer.root.find(
      (node) => node.type === 'select' && node.props['aria-label'] === '模型选择 / Model selection',
    );
    await act(async () => {
      await modelSelect.props.onChange({ currentTarget: { value: '__governor_auto__' } });
    });
    expect(selectMode).toHaveBeenLastCalledWith(sessionId, 'auto', {
      expectedRevision: 7,
      currentRoute: 'p:a',
    });
    expect(selectModel).not.toHaveBeenCalled();

    await act(async () => {
      await modelSelect.props.onChange({ currentTarget: { value: 'p\u0000b' } });
    });
    expect(selectModel).toHaveBeenCalledWith({ provider: 'p', model: 'b' });
    expect(selectMode).toHaveBeenLastCalledWith(sessionId, 'manual', {
      expectedRevision: 8,
      lastManualRoute: 'p:b',
    });
    const search = renderer.root.find(
      (node) => node.type === 'input' && node.props['aria-label'] === '搜索模型 / Search models',
    );
    await act(async () => {
      search.props.onChange({ currentTarget: { value: 'beta' } });
    });
    expect(
      renderer.root.findAllByType('option').some((node) => node.props.value === 'p\u0000b'),
    ).toBe(true);
  });

  it('Composer can enable Auto on a new session before any concrete model exists', async () => {
    const sessionId = 'session-empty' as SessionId;
    const selectMode = vi.fn(async (_id: SessionId, mode: 'auto' | 'manual') => ({
      mode,
      selectionRevision: 2,
    }));
    const api = emptySettingsApi({
      selection: async () => ({ mode: 'manual', selectionRevision: 1 }),
      selectMode,
    });
    const emptyDirectorySnapshot = {
      current: null,
      routable: null,
      groups: [],
      failures: [],
      status: 'ready' as const,
      error: null,
    };
    const directory = {
      subscribe: () => () => {},
      getSnapshot: () => emptyDirectorySnapshot,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(GovernorModelSelect, {
          locked: false,
          available: true,
          sessionId,
          directory,
          load: vi.fn(),
          selectModel: vi.fn(async () => true),
          api,
        }),
      );
    });
    await act(async () => {
      await renderer.root
        .findByProps({ 'aria-label': '模型选择 / Model selection' })
        .props.onChange({ currentTarget: { value: '__governor_auto__' } });
    });
    expect(selectMode).toHaveBeenCalledWith(sessionId, 'auto', { expectedRevision: 1 });
  });

  it('Composer exposes reasoning effort and renders nothing for addressed subagents', async () => {
    const sessionId = 'session-2' as SessionId;
    const selectModel = vi.fn(async () => true);
    const api = emptySettingsApi();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(GovernorModelSelect, {
          locked: false,
          available: true,
          sessionId,
          directory: modelStore(),
          load: vi.fn(),
          selectModel,
          api,
        }),
      );
    });
    const effort = renderer.root.find(
      (node) =>
        node.type === 'select' && node.props['aria-label'] === '推理强度 / Reasoning effort',
    );
    await act(async () => {
      await effort.props.onChange({ currentTarget: { value: 'high' } });
    });
    expect(selectModel).toHaveBeenCalledWith({
      provider: 'p',
      model: 'a',
      reasoningEffort: 'high',
    });

    const selection = vi.fn(async () => ({ mode: 'manual' as const, selectionRevision: 1 }));
    await act(async () => {
      renderer.update(
        createElement(GovernorModelSelect, {
          locked: false,
          available: false,
          sessionId,
          directory: modelStore(),
          load: vi.fn(),
          selectModel,
          api: emptySettingsApi({ selection }),
        }),
      );
    });
    expect(renderer.toJSON()).toBeNull();
    expect(selection).not.toHaveBeenCalled();
  });

  it('Composer surfaces load, unknown-model and rejected-selection errors without stale mode', async () => {
    const sessionId = 'session-errors' as SessionId;
    const selection = vi
      .fn()
      .mockRejectedValueOnce(new Error('SELECTION_LOAD_FAILED'))
      .mockResolvedValue({ mode: 'manual', selectionRevision: 4 });
    const api = emptySettingsApi({ selection });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(GovernorModelSelect, {
          locked: false,
          available: true,
          sessionId,
          directory: modelStore(),
          load: vi.fn(),
          selectModel: vi.fn(async () => false),
          api,
        }),
      );
    });
    expect(renderer.root.findByProps({ role: 'alert' }).props.title).toContain(
      'SELECTION_LOAD_FAILED',
    );

    await act(async () => {
      renderer.update(
        createElement(GovernorModelSelect, {
          locked: false,
          available: true,
          sessionId,
          directory: modelStore(),
          load: vi.fn(),
          selectModel: vi.fn(async () => false),
          api,
        }),
      );
    });
    const modelSelect = renderer.root.findByProps({
      'aria-label': '模型选择 / Model selection',
    });
    await act(async () => {
      await modelSelect.props.onChange({ currentTarget: { value: 'missing' } });
    });
    expect(renderer.root.findByProps({ role: 'alert' }).props.title).toBe('MODEL_NOT_FOUND');
    await act(async () => {
      await modelSelect.props.onChange({ currentTarget: { value: 'p\u0000b' } });
    });
    expect(renderer.root.findByProps({ role: 'alert' }).props.title).toBe(
      'MODEL_SELECTION_REJECTED',
    );
    const effort = renderer.root.findByProps({
      'aria-label': '推理强度 / Reasoning effort',
    });
    await act(async () => {
      await effort.props.onChange({ currentTarget: { value: 'low' } });
    });
    expect(renderer.root.findByProps({ role: 'alert' }).props.title).toBe(
      'MODEL_SELECTION_REJECTED',
    );
  });

  it('native Settings exposes Routing/Models/Users writes and 31-day Usage as read-only', async () => {
    const model: GovernorModelView = {
      routeId: 'p:a',
      provider: 'p',
      model: 'a',
      enabled: true,
      multiplierPpm: 1_000_000,
      capabilities: ['coding'],
      quality: { coding: 90 },
      configRevision: 2,
    };
    const user: GovernorUserView = {
      userId: 'alice',
      allow: ['p:a'],
      monthlyCredits: 100,
      usedCredits: 12,
      usedCreditNanos: '12500000001',
      configRevision: 2,
    };
    const usage: GovernorUsageView = {
      requestId: 'req-1',
      provider: 'p',
      model: 'a',
      inputTokens: 10,
      outputTokens: 5,
      creditNanos: '250000000',
      success: true,
      latencyMs: 42,
      fallbackIndex: 0,
      createdAt: new Date().toISOString(),
    };
    const saveRouting = vi.fn(emptySettingsApi().saveRouting);
    const saveModel = vi.fn(
      async (_routeId: string, patch: Parameters<GovernorClientApi['saveModel']>[1]) => ({
        ...model,
        ...patch,
      }),
    );
    const saveUser = vi.fn(async (_userId: string, patch: { monthlyCredits?: number }) => ({
      ...user,
      ...patch,
    }));
    const listModels = vi.fn(async () => [model]);
    const listUsers = vi.fn(async () => [user]);
    const api = emptySettingsApi({
      saveRouting,
      models: listModels,
      saveModel,
      users: listUsers,
      saveUser,
      usage31Days: async () => [
        usage,
        { ...usage, fallbackIndex: 1, creditNanos: '100000000000000000001' },
        { ...usage, fallbackIndex: 2, creditNanos: '-2000000000', success: false },
      ],
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(GovernorSettings, { api }));
    });
    const button = (label: string) =>
      renderer.root.findAllByType('button').find((node) => node.children.includes(label))!;

    const routingMode = renderer.root.find(
      (node) => node.type === 'select' && node.props.value === 'quality_first',
    );
    const minimumQuality = renderer.root.find(
      (node) => node.type === 'input' && node.props.value === 70,
    );
    await act(async () => {
      routingMode.props.onChange({ currentTarget: { value: 'auto' } });
      minimumQuality.props.onChange({ currentTarget: { valueAsNumber: 75 } });
    });
    await act(async () => {
      button('保存路由设置').props.onClick();
    });
    expect(saveRouting).toHaveBeenCalledTimes(1);
    await act(async () => {
      button('模型').props.onClick();
    });
    const enabled = renderer.root.find(
      (node) => node.type === 'input' && node.props['aria-label'] === 'p:a 启用',
    );
    await act(async () => {
      await enabled.props.onChange({ currentTarget: { checked: false } });
    });
    expect(saveModel).toHaveBeenCalledWith('p:a', { enabled: false }, 2);
    expect(listModels).toHaveBeenCalledTimes(2);
    const multiplier = renderer.root.find(
      (node) => node.type === 'input' && node.props['aria-label'] === 'p:a 倍率',
    );
    await act(async () => {
      await multiplier.props.onBlur({ currentTarget: { valueAsNumber: 1.5 } });
    });
    expect(saveModel).toHaveBeenCalledWith('p:a', { multiplier: 1.5 }, 2);
    const capabilities = renderer.root.find(
      (node) => node.type === 'input' && node.props['aria-label'] === 'p:a 能力',
    );
    await act(async () => {
      await capabilities.props.onBlur({ currentTarget: { value: 'vision, coding, vision' } });
    });
    expect(saveModel).toHaveBeenCalledWith('p:a', { capabilities: ['vision', 'coding'] }, 2);
    const codingQuality = renderer.root.find(
      (node) => node.type === 'input' && node.props['aria-label'] === 'p:a coding Quality',
    );
    await act(async () => {
      await codingQuality.props.onBlur({ currentTarget: { value: '95', valueAsNumber: 95 } });
    });
    expect(saveModel).toHaveBeenCalledWith('p:a', { quality: { coding: 95 } }, 2);
    const generalQuality = renderer.root.find(
      (node) => node.type === 'input' && node.props['aria-label'] === 'p:a general Quality',
    );
    await act(async () => {
      await generalQuality.props.onBlur({
        currentTarget: { value: '', valueAsNumber: Number.NaN },
      });
    });
    expect(saveModel).toHaveBeenCalledWith('p:a', { quality: { general: null } }, 2);

    await act(async () => {
      button('用户').props.onClick();
    });
    const credits = renderer.root.find(
      (node) => node.type === 'input' && node.props['type'] === 'number',
    );
    await act(async () => {
      await credits.props.onBlur({ currentTarget: { valueAsNumber: 200 } });
    });
    expect(saveUser).toHaveBeenCalledWith('alice', { monthlyCredits: 200 }, 2);
    const allow = renderer.root.find(
      (node) => node.type === 'input' && node.props['type'] === 'text',
    );
    await act(async () => {
      await allow.props.onBlur({ currentTarget: { value: 'p:b, p:a, p:b' } });
    });
    expect(saveUser).toHaveBeenCalledWith('alice', { allow: ['p:a', 'p:b'] }, 2);
    expect(listUsers).toHaveBeenCalledTimes(3);

    await act(async () => {
      button('用量').props.onClick();
    });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('只读 · 最近 31 天');
    expect(rendered).toContain('req-1');
    expect(rendered).toContain('100000000000.000000001');
    expect(rendered).toContain('99999999998.250000001');
    expect(rendered).toContain('-2');
    expect(rendered).toContain('失败');
    const requests = renderer.root.findAll(
      (node) => node.type === 'span' && node.children.includes('请求'),
    )[0]?.parent;
    expect(requests?.findByType('strong').children).toEqual(['1']);
  });

  it('describeAccess makes every manage control read-only while preserving native reads', async () => {
    const saveRouting = vi.fn(emptySettingsApi().saveRouting);
    const saveModel = vi.fn();
    const model: GovernorModelView = {
      routeId: 'p:a',
      provider: 'p',
      model: 'a',
      enabled: true,
      multiplierPpm: 1_000_000,
      capabilities: [],
      quality: {},
      configRevision: 2,
    };
    const api = emptySettingsApi({
      access: async () => ({ actorId: 'viewer', capabilities: ['governor.read'] }),
      saveRouting,
      models: async () => [model],
      saveModel,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(GovernorSettings, { api }));
    });
    const save = renderer.root
      .findAllByType('button')
      .find((node) => node.children.includes('保存路由设置'));
    expect(save?.props.disabled).toBe(true);
    expect(
      renderer.root
        .findAllByType('option')
        .some((node) => node.props.value === 'auto' && node.children.includes('自动')),
    ).toBe(true);
    const modelsTab = renderer.root
      .findAllByType('button')
      .find((node) => node.children.includes('模型'))!;
    await act(async () => {
      modelsTab.props.onClick();
    });
    const enabled = renderer.root.find(
      (node) => node.type === 'input' && node.props['aria-label'] === 'p:a 启用',
    );
    expect(enabled.props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Read-only · viewer');
    expect(saveRouting).not.toHaveBeenCalled();
    expect(saveModel).not.toHaveBeenCalled();
  });

  it('Settings exposes Host access/load/write failures in the native section', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(GovernorSettings, {
          api: emptySettingsApi({
            access: async () => {
              throw new Error('ACCESS_FAILED');
            },
          }),
        }),
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('ACCESS_FAILED');

    const model: GovernorModelView = {
      routeId: 'p:a',
      provider: 'p',
      model: 'a',
      enabled: true,
      multiplierPpm: 1_000_000,
      capabilities: [],
      quality: {},
      configRevision: 2,
    };
    const user: GovernorUserView = {
      userId: 'alice',
      allow: [],
      monthlyCredits: 1,
      configRevision: 2,
    };
    await act(async () => {
      renderer.unmount();
      renderer = TestRenderer.create(
        createElement(GovernorSettings, {
          api: emptySettingsApi({
            saveRouting: async () => {
              throw new Error('ROUTING_WRITE_FAILED');
            },
            models: async () => [model],
            saveModel: async () => {
              throw new Error('MODEL_WRITE_FAILED');
            },
            users: async () => [user],
            saveUser: async () => {
              throw new Error('USER_WRITE_FAILED');
            },
          }),
        }),
      );
    });
    const tab = (label: string) =>
      renderer.root.findAllByType('button').find((node) => node.children.includes(label))!;
    await act(async () => {
      tab('保存路由设置').props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('ROUTING_WRITE_FAILED');
    await act(async () => {
      tab('模型').props.onClick();
    });
    await act(async () => {
      await renderer.root
        .findByProps({ 'aria-label': 'p:a 启用' })
        .props.onChange({ currentTarget: { checked: false } });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('MODEL_WRITE_FAILED');
    await act(async () => {
      tab('用户').props.onClick();
    });
    await act(async () => {
      await renderer.root
        .find((node) => node.type === 'input' && node.props.type === 'number')
        .props.onBlur({ currentTarget: { valueAsNumber: 2 } });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('USER_WRITE_FAILED');
  });

  it('Settings surfaces each initial read failure without hiding navigation', async () => {
    const failed = (message: string) => async () => {
      throw new Error(message);
    };
    const api = emptySettingsApi({
      routing: failed('ROUTING_READ_FAILED'),
      models: failed('MODELS_READ_FAILED'),
      users: failed('USERS_READ_FAILED'),
      usage31Days: failed('USAGE_READ_FAILED'),
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(GovernorSettings, { api }));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('ROUTING_READ_FAILED');
    const tab = (label: string) =>
      renderer.root.findAllByType('button').find((node) => node.children.includes(label))!;
    for (const [label, error] of [
      ['模型', 'MODELS_READ_FAILED'],
      ['用户', 'USERS_READ_FAILED'],
      ['用量', 'USAGE_READ_FAILED'],
    ] as const) {
      await act(async () => {
        tab(label).props.onClick();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain(error);
    }
  });

  it('usage adapter requests an explicit bounded Host window and converts nanos exactly once', async () => {
    const queryUsage = vi.fn(() =>
      success([
        {
          requestId: 'req-usage',
          sessionId: 's',
          userId: 'u',
          provider: 'p',
          model: 'a',
          routingMode: 'auto',
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          creditNanos: '1250000000',
          success: true,
          latencyMs: 10,
          fallbackIndex: 0,
          createdAt: new Date().toISOString(),
        },
      ]),
    );
    const api = createGovernorClientApi({ ...remoteFace(), queryUsage });
    const rows = await api.usage31Days();
    expect(queryUsage).toHaveBeenCalledWith({
      from: expect.any(String),
      to: expect.any(String),
      limit: 200,
    });
    expect(rows[0]).toMatchObject({ creditNanos: '1250000000', fallbackIndex: 0 });
  });
});
