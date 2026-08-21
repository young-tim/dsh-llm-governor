/**
 * Governor browser half for DSH rc.8.
 *
 * This is an ordinary `dsh.client` plugin. The host-side client module registry
 * discovers the package from the live Loader tree, serves `dist/client.js`, and
 * mounts this `apply` function in the browser Cordis tree. Every registration
 * below therefore follows the plugin fiber and is removed by HMR/uninstall.
 */
import type { Context } from '@deepseek-ai/cordis';
import type {
  ClientContext,
  ConversationViewNode,
  SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client';
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { createElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  GOVERNOR_REMOTE_CONTRIBUTION,
  type GovernorRemoteApi,
} from '../plugin/typert-remote-client.js';
import type { GovernorRoutingSettings, GovernorRoutingSettingsPatch } from '../plugin/service.js';
import type { GovernorRemoteUsage } from '../plugin/remote-service.js';
import {
  governorDecisionViewDefinition,
  governorTrajectoryDefinition,
  type GovernorDecisionCardViewData,
  type GovernorDecisionViewSnapshot,
} from '../plugin/client-registration.js';

const CLIENT_ID = 'dsh-llm-governor';
const AUTO_VALUE = '__governor_auto__';

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface SelectionModeView {
  readonly mode: 'auto' | 'manual';
  readonly selectionRevision: number;
  readonly lastManualRoute?: string;
  readonly isDefault?: boolean;
}

export interface GovernorModelView {
  readonly routeId: string;
  readonly provider: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly multiplierPpm: number;
  readonly capabilities: readonly string[];
  readonly quality: Readonly<Record<string, number>>;
  readonly configRevision: number;
}

export interface GovernorUserView {
  readonly userId: string;
  readonly allow: readonly string[];
  readonly monthlyCredits: number;
  readonly usedCredits?: number;
  readonly usedCreditNanos?: string;
  readonly configRevision: number;
}

export type GovernorRoutingView = GovernorRoutingSettings;

export interface GovernorUsageView {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly creditNanos: string;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly fallbackIndex: number;
  readonly createdAt?: string;
}

/** Browser-safe face of the generated Governor Typert namespace. */
export type GovernorRemoteFace = GovernorRemoteApi;

export interface GovernorClientApi {
  access(): Promise<{ readonly actorId: string; readonly capabilities: readonly string[] }>;
  selection(sessionId: SessionId): Promise<SelectionModeView>;
  selectMode(
    sessionId: SessionId,
    mode: 'auto' | 'manual',
    options?: { expectedRevision?: number; lastManualRoute?: string; currentRoute?: string },
  ): Promise<SelectionModeView>;
  routing(): Promise<GovernorRoutingView>;
  saveRouting(
    patch: GovernorRoutingSettingsPatch,
    expectedRevision?: number,
  ): Promise<GovernorRoutingView>;
  models(): Promise<readonly GovernorModelView[]>;
  saveModel(
    routeId: string,
    patch: { enabled?: boolean; multiplier?: number },
    expectedRevision?: number,
  ): Promise<GovernorModelView>;
  users(): Promise<readonly GovernorUserView[]>;
  saveUser(
    userId: string,
    patch: { monthlyCredits?: number; allow?: string[] },
    expectedRevision?: number,
  ): Promise<GovernorUserView>;
  usage31Days(): Promise<readonly GovernorUsageView[]>;
}

function unwrap<T>(result: RemoteResult<T>, operation: string): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message || operation}`);
}

/** Build the UI adapter over the generated, Host-authorized Typert namespace. */
export function createGovernorClientApi(remote: GovernorRemoteFace): GovernorClientApi {
  return {
    access: async () => unwrap(await remote.describeAccess(), 'describeAccess'),
    selection: async (sessionId) =>
      unwrap(await remote.getSessionSelectionMode(sessionId), 'getSessionSelectionMode'),
    selectMode: async (sessionId, mode, options) =>
      unwrap(
        await remote.setSessionSelectionMode(sessionId, mode, options),
        'setSessionSelectionMode',
      ),
    routing: async () => unwrap(await remote.getRouting(), 'getRouting'),
    saveRouting: async (patch, expectedRevision) =>
      unwrap(
        await remote.updateRouting(
          patch,
          expectedRevision === undefined ? undefined : { expectedRevision },
        ),
        'updateRouting',
      ),
    models: async () => unwrap(await remote.listModels(), 'listModels'),
    saveModel: async (routeId, patch, expectedRevision) =>
      unwrap(
        await remote.updateModel(
          routeId,
          patch,
          expectedRevision === undefined ? undefined : { expectedRevision },
        ),
        'updateModel',
      ),
    users: async () => unwrap(await remote.listUsers(), 'listUsers'),
    saveUser: async (userId, patch, expectedRevision) =>
      unwrap(
        await remote.updateUser(
          userId,
          patch,
          expectedRevision === undefined ? undefined : { expectedRevision },
        ),
        'updateUser',
      ),
    usage31Days: async () => {
      const to = new Date();
      const from = new Date(to.getTime() - 31 * 24 * 60 * 60 * 1000);
      return unwrap(
        await remote.queryUsage({ from: from.toISOString(), to: to.toISOString(), limit: 200 }),
        'queryUsage',
      ).map((event: GovernorRemoteUsage): GovernorUsageView => ({
        requestId: event.requestId,
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        creditNanos: event.creditNanos,
        success: event.success,
        latencyMs: event.latencyMs,
        fallbackIndex: event.fallbackIndex,
        createdAt: event.createdAt,
      }));
    },
  };
}

interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

interface ModelDirectoryState {
  readonly current: ModelSelection | null;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly models: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly description?: string;
      readonly reasoning?: {
        readonly defaultEffort?: string;
        readonly efforts: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly description?: string;
        }>;
      };
    }>;
  }>;
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error';
  readonly error: string | null;
}

interface ModelDirectoryFace {
  readonly store: SnapshotStore<ModelDirectoryState>;
  load(): Promise<unknown>;
  select(selection: ModelSelection): Promise<void>;
}

interface ModelDirectoriesFace {
  directoryFor(sessionId: SessionId): ModelDirectoryFace;
}

interface AutoModelSelectProps {
  readonly locked: boolean;
  readonly available: boolean;
  readonly sessionId: SessionId;
  readonly directory: SnapshotStore<ModelDirectoryState>;
  readonly load: () => void;
  readonly selectModel: (selection: ModelSelection) => Promise<boolean>;
  readonly api: GovernorClientApi;
}

/** Native Composer model seat: Auto is the first control option, never a fake provider route. */
export function GovernorModelSelect({
  locked,
  available,
  sessionId,
  directory,
  load,
  selectModel,
  api,
}: AutoModelSelectProps) {
  const catalog = useSyncExternalStore(directory.subscribe, directory.getSnapshot);
  const [selection, setSelection] = useState<SelectionModeView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!available) return;
    let live = true;
    load();
    void api.selection(sessionId).then(
      (next) => {
        if (live) setSelection(next);
      },
      (cause: unknown) => {
        if (live) setError(String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [api, available, load, sessionId]);

  const choices = useMemo(
    () =>
      catalog.groups.flatMap((group) =>
        group.models.map((model) => ({
          value: `${group.id}\u0000${model.id}`,
          label: `${model.name} · ${group.name}`,
          route: `${group.id}:${model.id}`,
          model,
          selection: {
            provider: group.id,
            model: model.id,
            ...(model.reasoning?.defaultEffort === undefined
              ? {}
              : { reasoningEffort: model.reasoning.defaultEffort }),
          },
        })),
      ),
    [catalog.groups],
  );
  const manualValue =
    catalog.current === null ? '' : `${catalog.current.provider}\u0000${catalog.current.model}`;
  const value = selection?.mode === 'auto' ? AUTO_VALUE : manualValue;
  const selectedChoice = choices.find((choice) => choice.value === manualValue);
  const reasoning = selectedChoice?.model.reasoning;
  const effectiveEffort = catalog.current?.reasoningEffort ?? reasoning?.defaultEffort ?? '';
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleChoices =
    normalizedQuery === ''
      ? choices
      : choices.filter((choice) =>
          `${choice.label} ${choice.model.id}`.toLocaleLowerCase().includes(normalizedQuery),
        );

  const onChange = async (next: string) => {
    if (selection === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (next === AUTO_VALUE) {
        const currentRoute =
          catalog.current === null
            ? undefined
            : `${catalog.current.provider}:${catalog.current.model}`;
        setSelection(
          await api.selectMode(sessionId, 'auto', {
            expectedRevision: selection.selectionRevision,
            ...(currentRoute === undefined ? {} : { currentRoute }),
          }),
        );
      } else {
        const choice = choices.find((candidate) => candidate.value === next);
        if (choice === undefined) throw new Error('MODEL_NOT_FOUND');
        if (!(await selectModel(choice.selection))) throw new Error('MODEL_SELECTION_REJECTED');
        setSelection(
          await api.selectMode(sessionId, 'manual', {
            expectedRevision: selection.selectionRevision,
            lastManualRoute: choice.route,
          }),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSelection(await api.selection(sessionId).catch(() => selection));
    } finally {
      setSaving(false);
    }
  };

  const onEffortChange = async (reasoningEffort: string) => {
    if (catalog.current === null || selection === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const concrete: ModelSelection = {
        provider: catalog.current.provider,
        model: catalog.current.model,
        ...(reasoningEffort === '' ? {} : { reasoningEffort }),
      };
      if (!(await selectModel(concrete))) throw new Error('MODEL_SELECTION_REJECTED');
      setSelection(
        await api.selectMode(sessionId, 'manual', {
          expectedRevision: selection.selectionRevision,
          lastManualRoute: `${concrete.provider}:${concrete.model}`,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSelection(await api.selection(sessionId).catch(() => selection));
    } finally {
      setSaving(false);
    }
  };

  if (!available) return null;

  return createElement(
    'span',
    { className: 'dsh-governor-model-select' },
    createElement('input', {
      type: 'search',
      value: query,
      placeholder: '搜索模型',
      'aria-label': '搜索模型 / Search models',
      disabled: locked || saving,
      onChange: (event: { currentTarget: { value: string } }) =>
        setQuery(event.currentTarget.value),
    }),
    createElement(
      'select',
      {
        'aria-label': '模型选择 / Model selection',
        disabled: locked || saving || selection === null,
        value,
        onFocus: load,
        onChange: (event: { currentTarget: { value: string } }) => {
          void onChange(event.currentTarget.value);
        },
      },
      createElement('option', { value: AUTO_VALUE }, '自动（Governor） · Auto'),
      visibleChoices.map((choice) =>
        createElement('option', { key: choice.value, value: choice.value }, choice.label),
      ),
    ),
    reasoning === undefined
      ? null
      : createElement(
          'select',
          {
            'aria-label': '推理强度 / Reasoning effort',
            disabled: locked || saving || selection?.mode === 'auto',
            value: effectiveEffort,
            onChange: (event: { currentTarget: { value: string } }) => {
              void onEffortChange(event.currentTarget.value);
            },
          },
          reasoning.defaultEffort === undefined
            ? createElement('option', { value: '' }, '提供方默认')
            : null,
          reasoning.efforts.map((effort) =>
            createElement('option', { key: effort.id, value: effort.id }, effort.name),
          ),
        ),
    saving ? createElement('span', { role: 'status' }, '保存中…') : null,
    error === null ? null : createElement('span', { role: 'alert', title: error }, '!'),
  );
}

interface GovernorDecisionViewProps {
  readonly useSession: <T>(selector: (snapshot: { views: ReadonlyMap<string, unknown> }) => T) => T;
}

function metric(value: number | null, suffix = ''): string {
  return value === null ? '未知' : `${String(value)}${suffix}`;
}

function DecisionCard({ node }: { readonly node: ConversationViewNode }) {
  const data = node.data as GovernorDecisionCardViewData;
  const { summary, detail } = data;
  const selectionLabel =
    summary.selectionMode === 'auto'
      ? '自动选择'
      : summary.selectionMode === 'manual'
        ? '手动选择'
        : '选择模式未知';
  const locationLabel = `Turn ${detail.turn === null ? '未知' : String(detail.turn)} · Step ${
    detail.step === null ? '未知' : String(detail.step)
  }`;
  return createElement(
    'details',
    { className: 'dsh-governor-decision', 'data-decision-id': node.id },
    createElement(
      'summary',
      null,
      createElement(
        'span',
        { className: 'dsh-governor-decision-heading' },
        createElement('strong', null, selectionLabel),
        createElement('small', null, locationLabel),
      ),
      createElement('span', null, summary.selectedRoute ?? '未知模型'),
      createElement(
        'span',
        { className: `dsh-governor-outcome ${summary.outcome}` },
        summary.outcome,
      ),
      createElement(
        'span',
        null,
        `×${metric(summary.multiplierPpm === null ? null : summary.multiplierPpm / 1_000_000)}`,
      ),
    ),
    createElement(
      'dl',
      { className: 'dsh-governor-facts' },
      createElement('dt', null, '策略'),
      createElement('dd', null, summary.effectiveStrategy),
      createElement('dt', null, '质量'),
      createElement('dd', null, metric(summary.quality)),
      createElement('dt', null, 'Fallback'),
      createElement('dd', null, String(summary.fallbackIndex)),
      createElement('dt', null, '原因'),
      createElement('dd', null, summary.reason ?? '未知'),
      createElement('dt', null, 'Request ID'),
      createElement('dd', null, detail.requestId),
      createElement('dt', null, 'Revision'),
      createElement('dd', null, metric(detail.configRevision)),
    ),
    createElement('h4', null, '候选排序'),
    createElement(
      'ol',
      null,
      detail.candidates.map((candidate) =>
        createElement(
          'li',
          { key: candidate.routeId },
          `${candidate.routeId} · Q ${metric(candidate.quality)} · ×${metric(candidate.multiplierPpm === null ? null : candidate.multiplierPpm / 1_000_000)}`,
        ),
      ),
    ),
    detail.excluded.length === 0
      ? null
      : createElement(
          'div',
          null,
          createElement('h4', null, '已排除'),
          createElement(
            'ul',
            null,
            detail.excluded.map((item) =>
              createElement('li', { key: item.routeId }, `${item.routeId} · ${item.reason}`),
            ),
          ),
        ),
  );
}

/** Native conversation-view entry backed by the registered Governor view target. */
export function GovernorDecisionView({ useSession }: GovernorDecisionViewProps) {
  const snapshot = useSession(
    (session) => session.views.get('governor-decision') as GovernorDecisionViewSnapshot | undefined,
  );
  if (snapshot === undefined || snapshot.nodes.length === 0) {
    return createElement('div', { className: 'dsh-governor-empty' }, '当前会话暂无 Governor 决策');
  }
  const turnRank = new Map(snapshot.turnOrder.map((turn, index) => [turn, index] as const));
  const nodes = [...snapshot.nodes].sort((left, right) => {
    const a = (left.data as GovernorDecisionCardViewData).detail;
    const b = (right.data as GovernorDecisionCardViewData).detail;
    const aRank = a.turn === null ? Number.MAX_SAFE_INTEGER : (turnRank.get(a.turn) ?? a.turn);
    const bRank = b.turn === null ? Number.MAX_SAFE_INTEGER : (turnRank.get(b.turn) ?? b.turn);
    return (
      aRank - bRank ||
      (a.step ?? Number.MAX_SAFE_INTEGER) - (b.step ?? Number.MAX_SAFE_INTEGER) ||
      a.fallbackIndex - b.fallbackIndex ||
      left.key.localeCompare(right.key)
    );
  });
  const groups = new Map<
    string,
    { turn: number | null; step: number | null; nodes: ConversationViewNode[] }
  >();
  for (const node of nodes) {
    const detail = (node.data as GovernorDecisionCardViewData).detail;
    const key = `${String(detail.turn)}:${String(detail.step)}`;
    const group = groups.get(key) ?? { turn: detail.turn, step: detail.step, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }
  return createElement(
    'section',
    { className: 'dsh-governor-view', 'aria-label': 'Governor 路由轨迹' },
    [...groups.entries()].map(([key, group]) =>
      createElement(
        'section',
        { className: 'dsh-governor-step-group', key },
        createElement(
          'h3',
          null,
          `Turn ${group.turn === null ? '未知' : String(group.turn)} · Step ${
            group.step === null ? '未知' : String(group.step)
          }`,
        ),
        group.nodes.map((node) => createElement(DecisionCard, { key: node.key, node })),
      ),
    ),
  );
}

type SettingsTab = 'routing' | 'models' | 'users' | 'usage';

interface GovernorSettingsProps {
  readonly api: GovernorClientApi;
}

interface GovernorManagedSettingsProps extends GovernorSettingsProps {
  readonly canManage: boolean;
}

function ErrorNotice({ error }: { readonly error: string | null }) {
  return error === null
    ? null
    : createElement('p', { className: 'dsh-governor-error', role: 'alert' }, error);
}

function RoutingSettings({ api, canManage }: GovernorManagedSettingsProps) {
  const [value, setValue] = useState<GovernorRoutingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.routing().then(setValue, (cause: unknown) => setError(String(cause)));
  }, [api]);
  if (value === null) return createElement(ErrorNotice, { error: error ?? '正在加载路由策略…' });
  const save = async () => {
    setError(null);
    try {
      setValue(
        await api.saveRouting(
          {
            default: value.default,
            creditFirst: value.creditFirst,
            auto: value.auto,
            fallback: value.fallback,
          },
          value.configRevision,
        ),
      );
    } catch (cause) {
      setError(String(cause));
    }
  };
  return createElement(
    'div',
    { className: 'dsh-governor-form' },
    createElement(
      'label',
      null,
      '默认模式',
      createElement(
        'select',
        {
          value: value.default,
          disabled: !canManage,
          onChange: (event: { currentTarget: { value: string } }) =>
            setValue({
              ...value,
              default: event.currentTarget.value as GovernorRoutingView['default'],
            }),
        },
        createElement('option', { value: 'manual' }, '手动'),
        createElement('option', { value: 'auto' }, '自动'),
        createElement('option', { value: 'quality_first' }, '质量优先'),
        createElement('option', { value: 'credit_first' }, '额度优先'),
      ),
    ),
    createElement(
      'label',
      null,
      '最低质量',
      createElement('input', {
        type: 'number',
        min: 0,
        max: 100,
        value: value.creditFirst.minimumQuality,
        disabled: !canManage,
        onChange: (event: { currentTarget: { valueAsNumber: number } }) =>
          setValue({
            ...value,
            creditFirst: {
              ...value.creditFirst,
              minimumQuality: event.currentTarget.valueAsNumber,
            },
          }),
      }),
    ),
    createElement(
      'button',
      { type: 'button', disabled: !canManage, onClick: () => void save() },
      '保存路由设置',
    ),
    createElement(ErrorNotice, { error }),
  );
}

function ModelsSettings({ api, canManage }: GovernorManagedSettingsProps) {
  const [rows, setRows] = useState<readonly GovernorModelView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.models().then(setRows, (cause: unknown) => setError(String(cause)));
  }, [api]);
  const save = async (
    row: GovernorModelView,
    patch: { enabled?: boolean; multiplier?: number },
  ) => {
    try {
      await api.saveModel(row.routeId, patch, row.configRevision);
      // configRevision is global; refresh every row after one write so a
      // subsequent row never submits a stale revision copied at initial load.
      setRows(await api.models());
    } catch (cause) {
      setError(String(cause));
    }
  };
  return createElement(
    'div',
    null,
    createElement(ErrorNotice, { error }),
    createElement(
      'div',
      { className: 'dsh-governor-table-wrap' },
      createElement(
        'table',
        null,
        createElement(
          'thead',
          null,
          createElement(
            'tr',
            null,
            ['模型', '启用', '倍率', '能力', '质量'].map((label) =>
              createElement('th', { key: label }, label),
            ),
          ),
        ),
        createElement(
          'tbody',
          null,
          rows.map((row) =>
            createElement(
              'tr',
              { key: row.routeId },
              createElement(
                'td',
                null,
                createElement('strong', null, row.model),
                createElement('small', null, row.provider),
              ),
              createElement(
                'td',
                null,
                createElement('input', {
                  type: 'checkbox',
                  checked: row.enabled,
                  disabled: !canManage,
                  'aria-label': `${row.routeId} 启用`,
                  onChange: (event: { currentTarget: { checked: boolean } }) =>
                    void save(row, { enabled: event.currentTarget.checked }),
                }),
              ),
              createElement(
                'td',
                null,
                createElement('input', {
                  type: 'number',
                  min: 0,
                  step: 0.01,
                  defaultValue: row.multiplierPpm / 1_000_000,
                  disabled: !canManage,
                  'aria-label': `${row.routeId} 倍率`,
                  onBlur: (event: { currentTarget: { valueAsNumber: number } }) =>
                    void save(row, { multiplier: event.currentTarget.valueAsNumber }),
                }),
              ),
              createElement('td', null, row.capabilities.join(', ') || '—'),
              createElement(
                'td',
                null,
                Object.entries(row.quality)
                  .map(([key, score]) => `${key} ${score}`)
                  .join(' · ') || '—',
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function formatCreditNanos(value: string): string {
  const nanos = BigInt(value);
  const negative = nanos < 0n;
  const absolute = negative ? -nanos : nanos;
  const whole = absolute / 1_000_000_000n;
  const fraction = (absolute % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction === '' ? '' : `.${fraction}`}`;
}

function UsersSettings({ api, canManage }: GovernorManagedSettingsProps) {
  const [rows, setRows] = useState<readonly GovernorUserView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.users().then(setRows, (cause: unknown) => setError(String(cause)));
  }, [api]);
  const save = async (
    row: GovernorUserView,
    patch: { monthlyCredits?: number; allow?: string[] },
  ) => {
    try {
      await api.saveUser(row.userId, patch, row.configRevision);
      setRows(await api.users());
    } catch (cause) {
      setError(String(cause));
    }
  };
  return createElement(
    'div',
    null,
    createElement(ErrorNotice, { error }),
    rows.map((row) =>
      createElement(
        'fieldset',
        { key: row.userId, className: 'dsh-governor-user' },
        createElement('legend', null, row.userId),
        createElement(
          'label',
          null,
          '每月额度',
          createElement('input', {
            type: 'number',
            min: 0,
            defaultValue: row.monthlyCredits,
            disabled: !canManage,
            onBlur: (event: { currentTarget: { valueAsNumber: number } }) =>
              void save(row, { monthlyCredits: event.currentTarget.valueAsNumber }),
          }),
        ),
        createElement(
          'label',
          null,
          '允许模型',
          createElement('input', {
            type: 'text',
            defaultValue: row.allow.join(', '),
            disabled: !canManage,
            title: '由 Host 校验并保存模型 Allow List',
            onBlur: (event: { currentTarget: { value: string } }) =>
              void save(row, {
                allow: [...new Set(event.currentTarget.value.split(',').map((item) => item.trim()))]
                  .filter(Boolean)
                  .sort(),
              }),
          }),
        ),
        createElement(
          'output',
          null,
          `已用 ${
            row.usedCreditNanos === undefined
              ? String(row.usedCredits ?? 0)
              : formatCreditNanos(row.usedCreditNanos)
          }`,
        ),
      ),
    ),
  );
}

function UsageSettings({ api }: GovernorSettingsProps) {
  const [rows, setRows] = useState<readonly GovernorUsageView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.usage31Days().then(setRows, (cause: unknown) => setError(String(cause)));
  }, [api]);
  const totals = useMemo(() => {
    const requests = new Set(rows.map((row) => row.requestId)).size;
    const tokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    const creditNanos = rows.reduce((sum, row) => sum + BigInt(row.creditNanos), 0n);
    return { requests, tokens, creditNanos };
  }, [rows]);
  return createElement(
    'div',
    null,
    createElement('p', { className: 'dsh-governor-readonly' }, '只读 · 最近 31 天'),
    createElement(ErrorNotice, { error }),
    createElement(
      'div',
      { className: 'dsh-governor-metrics' },
      createElement(
        'div',
        null,
        createElement('strong', null, String(totals.requests)),
        createElement('span', null, '请求'),
      ),
      createElement(
        'div',
        null,
        createElement('strong', null, String(totals.tokens)),
        createElement('span', null, 'Tokens'),
      ),
      createElement(
        'div',
        null,
        createElement('strong', null, formatCreditNanos(totals.creditNanos.toString())),
        createElement('span', null, 'Credits'),
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-governor-table-wrap' },
      createElement(
        'table',
        null,
        createElement(
          'thead',
          null,
          createElement(
            'tr',
            null,
            ['请求', '模型', 'Tokens', 'Credits', '时延', '结果'].map((label) =>
              createElement('th', { key: label }, label),
            ),
          ),
        ),
        createElement(
          'tbody',
          null,
          rows.map((row) =>
            createElement(
              'tr',
              { key: `${row.requestId}:${String(row.fallbackIndex)}` },
              createElement('td', null, `${row.requestId} #${String(row.fallbackIndex)}`),
              createElement('td', null, `${row.provider}:${row.model}`),
              createElement('td', null, String(row.inputTokens + row.outputTokens)),
              createElement('td', null, formatCreditNanos(row.creditNanos)),
              createElement('td', null, `${row.latencyMs} ms`),
              createElement('td', null, row.success ? '成功' : '失败'),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Native DSH Settings section; Host Remote remains the only data authority. */
export function GovernorSettings({ api }: GovernorSettingsProps) {
  const [tab, setTab] = useState<SettingsTab>('routing');
  const [access, setAccess] = useState<{
    readonly actorId: string;
    readonly capabilities: readonly string[];
  } | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.access().then(
      (value) => {
        if (live) setAccess(value);
      },
      (cause: unknown) => {
        if (live) setAccessError(String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);
  const canManage = access?.capabilities.includes('governor.manage') === true;
  const tabs: ReadonlyArray<{ key: SettingsTab; label: string }> = [
    { key: 'routing', label: '路由' },
    { key: 'models', label: '模型' },
    { key: 'users', label: '用户' },
    { key: 'usage', label: '用量' },
  ];
  const content =
    tab === 'routing'
      ? createElement(RoutingSettings, { api, canManage })
      : tab === 'models'
        ? createElement(ModelsSettings, { api, canManage })
        : tab === 'users'
          ? createElement(UsersSettings, { api, canManage })
          : createElement(UsageSettings, { api });
  return createElement(
    'section',
    { className: 'dsh-governor-settings', 'aria-label': 'Governor 设置' },
    createElement(
      'header',
      null,
      createElement(
        'div',
        null,
        createElement('p', null, 'MODEL GOVERNANCE'),
        createElement('h2', null, 'Governor'),
      ),
      createElement(
        'span',
        null,
        access === null
          ? 'Host access…'
          : canManage
            ? `Host-managed · ${access.actorId}`
            : `Read-only · ${access.actorId}`,
      ),
    ),
    createElement(
      'nav',
      { 'aria-label': 'Governor 设置分区' },
      tabs.map((item) =>
        createElement(
          'button',
          {
            key: item.key,
            type: 'button',
            className: tab === item.key ? 'active' : '',
            'aria-current': tab === item.key ? 'page' : undefined,
            onClick: () => setTab(item.key),
          },
          item.label,
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-governor-settings-body' },
      accessError === null
        ? access === null
          ? createElement('p', { role: 'status' }, '正在确认 Host 权限…')
          : content
        : createElement(ErrorNotice, { error: accessError }),
    ),
  );
}

const STYLES = `
.dsh-governor-model-select{display:inline-flex;align-items:center;gap:6px}.dsh-governor-model-select select,.dsh-governor-model-select input{max-width:250px;border:0;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);padding:5px 8px;font:inherit}.dsh-governor-model-select input{width:110px}.dsh-governor-model-select [role=status],.dsh-governor-model-select [role=alert]{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-governor-view{box-sizing:border-box;display:grid;gap:16px;max-width:920px;margin:0 auto;padding:18px}.dsh-governor-step-group{display:grid;gap:10px}.dsh-governor-step-group>h3{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;letter-spacing:.04em}.dsh-governor-empty{padding:48px;text-align:center;color:var(--dsw-alias-label-tertiary)}.dsh-governor-decision{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}.dsh-governor-decision summary{cursor:pointer;display:grid;grid-template-columns:minmax(110px,1fr) minmax(160px,2fr) auto auto;align-items:center;gap:12px;padding:14px 16px}.dsh-governor-decision-heading strong,.dsh-governor-decision-heading small{display:block}.dsh-governor-decision-heading small{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:10px}.dsh-governor-decision>dl,.dsh-governor-decision>h4,.dsh-governor-decision>ol,.dsh-governor-decision>div{margin-left:18px;margin-right:18px}.dsh-governor-outcome{font-size:12px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover)}.dsh-governor-outcome.rejected{color:var(--dsw-alias-state-error-primary)}.dsh-governor-facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:14px}.dsh-governor-facts dt{color:var(--dsw-alias-label-tertiary)}.dsh-governor-facts dd{margin:0;overflow-wrap:anywhere}
.dsh-governor-settings{color:var(--dsw-alias-label-primary)}.dsh-governor-settings>header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid var(--dsw-alias-border-l2);padding:6px 0 14px}.dsh-governor-settings>header p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:.14em}.dsh-governor-settings>header h2{margin:2px 0 0;font:600 25px/1.2 Georgia,serif}.dsh-governor-settings>header>span,.dsh-governor-readonly{font-size:12px;color:var(--dsw-alias-label-tertiary)}.dsh-governor-settings nav{display:flex;gap:4px;padding:14px 0}.dsh-governor-settings nav button,.dsh-governor-form button{border:0;border-radius:9px;background:transparent;color:inherit;padding:7px 12px;font:inherit;cursor:pointer}.dsh-governor-settings nav button:hover,.dsh-governor-settings nav button.active{background:var(--dsw-alias-interactive-bg-hover)}.dsh-governor-settings-body{min-height:280px}.dsh-governor-form{display:grid;max-width:420px;gap:14px}.dsh-governor-form label,.dsh-governor-user label{display:grid;gap:6px;font-size:13px}.dsh-governor-form input,.dsh-governor-form select,.dsh-governor-user input,.dsh-governor-table-wrap input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:8px}.dsh-governor-form button{justify-self:start;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2)}.dsh-governor-table-wrap{max-width:100%;overflow:auto}.dsh-governor-table-wrap table{width:100%;border-collapse:collapse;font-size:13px}.dsh-governor-table-wrap th,.dsh-governor-table-wrap td{text-align:left;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 8px;vertical-align:top}.dsh-governor-table-wrap small{display:block;color:var(--dsw-alias-label-tertiary)}.dsh-governor-user{display:grid;grid-template-columns:1fr 2fr auto;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;margin:0 0 10px;padding:12px}.dsh-governor-user legend{padding:0 5px}.dsh-governor-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.dsh-governor-metrics>div{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px}.dsh-governor-metrics strong,.dsh-governor-metrics span{display:block}.dsh-governor-metrics strong{font-size:22px}.dsh-governor-metrics span{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dsh-governor-error{border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);padding:8px 10px;font-size:12px}
@media(max-width:600px){.dsh-governor-decision summary{grid-template-columns:1fr auto}.dsh-governor-user{grid-template-columns:1fr}.dsh-governor-metrics{grid-template-columns:1fr}.dsh-governor-settings nav{overflow-x:auto}}
`;

interface SlotsPort {
  inject(key: string, callback: () => () => void): () => void;
  register(
    spec: Record<string, unknown>,
    component: (props: never) => ReturnType<typeof createElement> | null,
  ): () => void;
}

type BrowserContext = ClientContext & {
  readonly remote: TypertClientRemote;
  readonly modelDirectories: ModelDirectoriesFace;
};

function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {};
  const selector = `style[data-plugin-css="${CLIENT_ID}"]`;
  if (document.querySelector(selector) !== null) return () => {};
  const tag = document.createElement('style');
  tag.dataset['plugin'] = CLIENT_ID;
  tag.dataset['pluginCss'] = CLIENT_ID;
  tag.textContent = STYLES;
  document.head.append(tag);
  return () => tag.remove();
}

/** Required rc.8 client services. */
export const inject = [
  'conversationEvents',
  'conversationViews',
  'modelDirectories',
  'remote',
  'sessions',
  'slots',
];

/** Mount all native Governor browser surfaces with one reversible lifecycle. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const browser = ctx as unknown as BrowserContext;
  const slots = browser.slots as unknown as SlotsPort;
  const disposers: Array<() => void | Promise<void>> = [];
  try {
    const disposeRemote = await browser.remote.$mount(GOVERNOR_REMOTE_CONTRIBUTION);
    disposers.push(disposeRemote);
    // `$mount()` dynamically provides `remote.governor`.  Reading it through
    // `browser.remote.governor` makes Cordis treat the nested service as an
    // undeclared static dependency; declaring it in `inject` would instead
    // create a self-dependency because this plugin is the namespace owner.
    // `Context#get()` is the supported explicit lookup for a service created
    // during the current plugin's apply lifecycle.
    const governorRemote = ctx.get('remote.governor') as GovernorRemoteFace | undefined;
    if (governorRemote === undefined) {
      throw new Error('Governor Remote namespace did not become available after mount');
    }
    const api = createGovernorClientApi(governorRemote);
    disposers.push(installStyles());
    disposers.push(browser.conversationEvents.register(governorTrajectoryDefinition));
    disposers.push(browser.conversationViews.register(governorDecisionViewDefinition));
    disposers.push(
      slots.inject('conversation.view', () =>
        slots.register(
          {
            name: 'conversation.view',
            id: 'governor',
            order: 11,
            label: () => 'Governor 轨迹',
          },
          GovernorDecisionView as never,
        ),
      ),
    );
    disposers.push(
      slots.inject('conversation.input.model', () =>
        slots.register(
          {
            name: 'conversation.input.model',
            // rc.8 single-slot cells reject equal priorities and render the
            // lowest live priority.  The shipped selector uses the default 0;
            // Governor intentionally shadows it and its disposer reveals the
            // shipped entry again on HMR/uninstall.
            priority: -10,
            inject: (sessionId: SessionId) => {
              const directory = browser.modelDirectories.directoryFor(sessionId);
              const available = browser.sessions.subagentAddress(sessionId) === undefined;
              return {
                api,
                available,
                sessionId,
                directory: directory.store,
                load: () => {
                  if (available) void directory.load().catch(() => {});
                },
                selectModel: (selection: ModelSelection) =>
                  available
                    ? directory.select(selection).then(
                        () => true,
                        () => false,
                      )
                    : Promise.resolve(false),
              };
            },
          },
          GovernorModelSelect as never,
        ),
      ),
    );
    disposers.push(
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'governor',
            order: 30,
            label: () => 'Governor',
            inject: () => ({ api }),
          },
          GovernorSettings as never,
        ),
      ),
    );
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        // Preserve the setup failure; cleanup is best-effort for partial setup.
      }
    }
    throw error;
  }
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) await dispose();
  };
}
