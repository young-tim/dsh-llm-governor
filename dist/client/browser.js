import { createElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { GOVERNOR_REMOTE_CONTRIBUTION, } from '../plugin/typert-remote-client.js';
import { TASK_TYPES } from '../index.js';
import { governorTrajectoryDefinition } from '../plugin/client-registration.js';
const CLIENT_ID = 'dsh-llm-governor';
const AUTO_VALUE = '__governor_auto__';
function unwrap(result, operation) {
    if (result.ok)
        return result.value;
    throw new Error(`${result.error.code}: ${result.error.message || operation}`);
}
/** Build the UI adapter over the generated, Host-authorized Typert namespace. */
export function createGovernorClientApi(remote) {
    return {
        access: async () => unwrap(await remote.describeAccess(), 'describeAccess'),
        selection: async (sessionId) => unwrap(await remote.getSessionSelectionMode(sessionId), 'getSessionSelectionMode'),
        selectMode: async (sessionId, mode, options) => unwrap(await remote.setSessionSelectionMode(sessionId, mode, options), 'setSessionSelectionMode'),
        routing: async () => unwrap(await remote.getRouting(), 'getRouting'),
        saveRouting: async (patch, expectedRevision) => unwrap(await remote.updateRouting(patch, expectedRevision === undefined ? undefined : { expectedRevision }), 'updateRouting'),
        models: async () => unwrap(await remote.listModels(), 'listModels'),
        saveModel: async (routeId, patch, expectedRevision) => unwrap(await remote.updateModel(routeId, patch, expectedRevision === undefined ? undefined : { expectedRevision }), 'updateModel'),
        users: async () => unwrap(await remote.listUsers(), 'listUsers'),
        saveUser: async (userId, patch, expectedRevision) => unwrap(await remote.updateUser(userId, patch, expectedRevision === undefined ? undefined : { expectedRevision }), 'updateUser'),
        usage31Days: async () => {
            const to = new Date();
            const from = new Date(to.getTime() - 31 * 24 * 60 * 60 * 1000);
            return unwrap(await remote.queryUsage({ from: from.toISOString(), to: to.toISOString(), limit: 200 }), 'queryUsage').map((event) => ({
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
/** Native Composer model seat: Auto is the first control option, never a fake provider route. */
export function GovernorModelSelect({ locked, available, sessionId, directory, load, selectModel, api, }) {
    const catalog = useSyncExternalStore(directory.subscribe, directory.getSnapshot);
    const [selection, setSelection] = useState(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    useEffect(() => {
        if (!available)
            return;
        let live = true;
        load();
        void api.selection(sessionId).then((next) => {
            if (live)
                setSelection(next);
        }, (cause) => {
            if (live)
                setError(String(cause));
        });
        return () => {
            live = false;
        };
    }, [api, available, load, sessionId]);
    const choices = useMemo(() => catalog.groups.flatMap((group) => group.models.map((model) => ({
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
    }))), [catalog.groups]);
    const manualValue = catalog.current === null ? '' : `${catalog.current.provider}\u0000${catalog.current.model}`;
    const value = selection?.mode === 'auto' ? AUTO_VALUE : manualValue;
    const selectedChoice = choices.find((choice) => choice.value === manualValue);
    const reasoning = selectedChoice?.model.reasoning;
    const effectiveEffort = catalog.current?.reasoningEffort ?? reasoning?.defaultEffort ?? '';
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleChoices = normalizedQuery === ''
        ? choices
        : choices.filter((choice) => `${choice.label} ${choice.model.id}`.toLocaleLowerCase().includes(normalizedQuery));
    const onChange = async (next) => {
        if (selection === null || saving)
            return;
        setSaving(true);
        setError(null);
        try {
            if (next === AUTO_VALUE) {
                const currentRoute = catalog.current === null
                    ? undefined
                    : `${catalog.current.provider}:${catalog.current.model}`;
                setSelection(await api.selectMode(sessionId, 'auto', {
                    expectedRevision: selection.selectionRevision,
                    ...(currentRoute === undefined ? {} : { currentRoute }),
                }));
            }
            else {
                const choice = choices.find((candidate) => candidate.value === next);
                if (choice === undefined)
                    throw new Error('MODEL_NOT_FOUND');
                if (!(await selectModel(choice.selection)))
                    throw new Error('MODEL_SELECTION_REJECTED');
                setSelection(await api.selectMode(sessionId, 'manual', {
                    expectedRevision: selection.selectionRevision,
                    lastManualRoute: choice.route,
                }));
            }
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setSelection(await api.selection(sessionId).catch(() => selection));
        }
        finally {
            setSaving(false);
        }
    };
    const onEffortChange = async (reasoningEffort) => {
        if (catalog.current === null || selection === null || saving)
            return;
        setSaving(true);
        setError(null);
        try {
            const concrete = {
                provider: catalog.current.provider,
                model: catalog.current.model,
                ...(reasoningEffort === '' ? {} : { reasoningEffort }),
            };
            if (!(await selectModel(concrete)))
                throw new Error('MODEL_SELECTION_REJECTED');
            setSelection(await api.selectMode(sessionId, 'manual', {
                expectedRevision: selection.selectionRevision,
                lastManualRoute: `${concrete.provider}:${concrete.model}`,
            }));
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setSelection(await api.selection(sessionId).catch(() => selection));
        }
        finally {
            setSaving(false);
        }
    };
    if (!available)
        return null;
    return createElement('span', { className: 'dsh-governor-model-select' }, createElement('input', {
        type: 'search',
        value: query,
        placeholder: '搜索模型',
        'aria-label': '搜索模型 / Search models',
        disabled: locked || saving,
        onChange: (event) => setQuery(event.currentTarget.value),
    }), createElement('select', {
        'aria-label': '模型选择 / Model selection',
        disabled: locked || saving || selection === null,
        value,
        onFocus: load,
        onChange: (event) => {
            void onChange(event.currentTarget.value);
        },
    }, createElement('option', { value: AUTO_VALUE }, '自动（Governor） · Auto'), visibleChoices.map((choice) => createElement('option', { key: choice.value, value: choice.value }, choice.label))), reasoning === undefined
        ? null
        : createElement('select', {
            'aria-label': '推理强度 / Reasoning effort',
            disabled: locked || saving || selection?.mode === 'auto',
            value: effectiveEffort,
            onChange: (event) => {
                void onEffortChange(event.currentTarget.value);
            },
        }, reasoning.defaultEffort === undefined
            ? createElement('option', { value: '' }, '提供方默认')
            : null, reasoning.efforts.map((effort) => createElement('option', { key: effort.id, value: effort.id }, effort.name))), saving ? createElement('span', { role: 'status' }, '保存中…') : null, error === null ? null : createElement('span', { role: 'alert', title: error }, '!'));
}
function ErrorNotice({ error }) {
    return error === null
        ? null
        : createElement('p', { className: 'dsh-governor-error', role: 'alert' }, error);
}
function RoutingSettings({ api, canManage }) {
    const [value, setValue] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        void api.routing().then(setValue, (cause) => setError(String(cause)));
    }, [api]);
    if (value === null)
        return createElement(ErrorNotice, { error: error ?? '正在加载路由策略…' });
    const save = async () => {
        setError(null);
        try {
            setValue(await api.saveRouting({
                default: value.default,
                creditFirst: value.creditFirst,
                auto: value.auto,
                fallback: value.fallback,
            }, value.configRevision));
        }
        catch (cause) {
            setError(String(cause));
        }
    };
    return createElement('div', { className: 'dsh-governor-form' }, createElement('label', null, '默认模式', createElement('select', {
        value: value.default,
        disabled: !canManage,
        onChange: (event) => setValue({
            ...value,
            default: event.currentTarget.value,
        }),
    }, createElement('option', { value: 'manual' }, '手动'), createElement('option', { value: 'auto' }, '自动'), createElement('option', { value: 'quality_first' }, '质量优先'), createElement('option', { value: 'credit_first' }, '额度优先'))), createElement('label', null, '最低质量', createElement('input', {
        type: 'number',
        min: 0,
        max: 100,
        value: value.creditFirst.minimumQuality,
        disabled: !canManage,
        onChange: (event) => setValue({
            ...value,
            creditFirst: {
                ...value.creditFirst,
                minimumQuality: event.currentTarget.valueAsNumber,
            },
        }),
    })), createElement('button', { type: 'button', disabled: !canManage, onClick: () => void save() }, '保存路由设置'), createElement(ErrorNotice, { error }));
}
function ModelsSettings({ api, canManage }) {
    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    useEffect(() => {
        void api.models().then(setRows, (cause) => setError(String(cause)));
    }, [api]);
    const save = async (row, patch) => {
        try {
            await api.saveModel(row.routeId, patch, row.configRevision);
            // configRevision is global; refresh every row after one write so a
            // subsequent row never submits a stale revision copied at initial load.
            setRows(await api.models());
        }
        catch (cause) {
            setError(String(cause));
        }
    };
    return createElement('div', null, createElement(ErrorNotice, { error }), createElement('div', { className: 'dsh-governor-table-wrap' }, createElement('table', null, createElement('thead', null, createElement('tr', null, ['模型', '启用', '倍率', '能力', '质量'].map((label) => createElement('th', { key: label }, label)))), createElement('tbody', null, rows.map((row) => createElement('tr', { key: row.routeId }, createElement('td', null, createElement('strong', null, row.model), createElement('small', null, row.provider)), createElement('td', null, createElement('input', {
        type: 'checkbox',
        checked: row.enabled,
        disabled: !canManage,
        'aria-label': `${row.routeId} 启用`,
        onChange: (event) => void save(row, { enabled: event.currentTarget.checked }),
    })), createElement('td', null, createElement('input', {
        type: 'number',
        min: 0,
        step: 0.01,
        defaultValue: row.multiplierPpm / 1_000_000,
        disabled: !canManage,
        'aria-label': `${row.routeId} 倍率`,
        onBlur: (event) => void save(row, { multiplier: event.currentTarget.valueAsNumber }),
    })), createElement('td', null, createElement('input', {
        type: 'text',
        defaultValue: row.capabilities.join(', '),
        placeholder: 'vision, tool_use',
        disabled: !canManage,
        'aria-label': `${row.routeId} 能力`,
        onBlur: (event) => void save(row, {
            capabilities: [
                ...new Set(event.currentTarget.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean)),
            ],
        }),
    })), createElement('td', null, createElement('details', { className: 'dsh-governor-quality' }, createElement('summary', null, Object.keys(row.quality).length === 0
        ? '未配置（Auto 不可用）'
        : Object.entries(row.quality)
            .map(([key, score]) => `${key} ${score}`)
            .join(' · ')), TASK_TYPES.map((taskType) => createElement('label', { key: taskType }, taskType, createElement('input', {
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        defaultValue: row.quality[taskType] ?? '',
        placeholder: '0–100',
        disabled: !canManage,
        'aria-label': `${row.routeId} ${taskType} Quality`,
        onBlur: (event) => {
            const score = event.currentTarget.value.trim() === ''
                ? null
                : event.currentTarget.valueAsNumber;
            void save(row, { quality: { [taskType]: score } });
        },
    })))))))))));
}
function formatCreditNanos(value) {
    const nanos = BigInt(value);
    const negative = nanos < 0n;
    const absolute = negative ? -nanos : nanos;
    const whole = absolute / 1000000000n;
    const fraction = (absolute % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole.toString()}${fraction === '' ? '' : `.${fraction}`}`;
}
function UsersSettings({ api, canManage }) {
    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    useEffect(() => {
        void api.users().then(setRows, (cause) => setError(String(cause)));
    }, [api]);
    const save = async (row, patch) => {
        try {
            await api.saveUser(row.userId, patch, row.configRevision);
            setRows(await api.users());
        }
        catch (cause) {
            setError(String(cause));
        }
    };
    return createElement('div', null, createElement(ErrorNotice, { error }), rows.map((row) => createElement('fieldset', { key: row.userId, className: 'dsh-governor-user' }, createElement('legend', null, row.userId), createElement('label', null, '每月额度', createElement('input', {
        type: 'number',
        min: 0,
        defaultValue: row.monthlyCredits,
        disabled: !canManage,
        onBlur: (event) => void save(row, { monthlyCredits: event.currentTarget.valueAsNumber }),
    })), createElement('label', null, '允许模型', createElement('input', {
        type: 'text',
        defaultValue: row.allow.join(', '),
        disabled: !canManage,
        title: '由 Host 校验并保存模型 Allow List',
        onBlur: (event) => void save(row, {
            allow: [...new Set(event.currentTarget.value.split(',').map((item) => item.trim()))]
                .filter(Boolean)
                .sort(),
        }),
    })), createElement('output', null, `已用 ${row.usedCreditNanos === undefined
        ? String(row.usedCredits ?? 0)
        : formatCreditNanos(row.usedCreditNanos)}`))));
}
function UsageSettings({ api }) {
    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    useEffect(() => {
        void api.usage31Days().then(setRows, (cause) => setError(String(cause)));
    }, [api]);
    const totals = useMemo(() => {
        const requests = new Set(rows.map((row) => row.requestId)).size;
        const tokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
        const creditNanos = rows.reduce((sum, row) => sum + BigInt(row.creditNanos), 0n);
        return { requests, tokens, creditNanos };
    }, [rows]);
    return createElement('div', null, createElement('p', { className: 'dsh-governor-readonly' }, '只读 · 最近 31 天'), createElement(ErrorNotice, { error }), createElement('div', { className: 'dsh-governor-metrics' }, createElement('div', null, createElement('strong', null, String(totals.requests)), createElement('span', null, '请求')), createElement('div', null, createElement('strong', null, String(totals.tokens)), createElement('span', null, 'Tokens')), createElement('div', null, createElement('strong', null, formatCreditNanos(totals.creditNanos.toString())), createElement('span', null, 'Credits'))), createElement('div', { className: 'dsh-governor-table-wrap' }, createElement('table', null, createElement('thead', null, createElement('tr', null, ['请求', '模型', 'Tokens', 'Credits', '时延', '结果'].map((label) => createElement('th', { key: label }, label)))), createElement('tbody', null, rows.map((row) => createElement('tr', { key: `${row.requestId}:${String(row.fallbackIndex)}` }, createElement('td', null, `${row.requestId} #${String(row.fallbackIndex)}`), createElement('td', null, `${row.provider}:${row.model}`), createElement('td', null, String(row.inputTokens + row.outputTokens)), createElement('td', null, formatCreditNanos(row.creditNanos)), createElement('td', null, `${row.latencyMs} ms`), createElement('td', null, row.success ? '成功' : '失败')))))));
}
/** Native DSH Settings section; Host Remote remains the only data authority. */
export function GovernorSettings({ api }) {
    const [tab, setTab] = useState('routing');
    const [access, setAccess] = useState(null);
    const [accessError, setAccessError] = useState(null);
    useEffect(() => {
        let live = true;
        void api.access().then((value) => {
            if (live)
                setAccess(value);
        }, (cause) => {
            if (live)
                setAccessError(String(cause));
        });
        return () => {
            live = false;
        };
    }, [api]);
    const canManage = access?.capabilities.includes('governor.manage') === true;
    const tabs = [
        { key: 'routing', label: '路由' },
        { key: 'models', label: '模型' },
        { key: 'users', label: '用户' },
        { key: 'usage', label: '用量' },
    ];
    const content = tab === 'routing'
        ? createElement(RoutingSettings, { api, canManage })
        : tab === 'models'
            ? createElement(ModelsSettings, { api, canManage })
            : tab === 'users'
                ? createElement(UsersSettings, { api, canManage })
                : createElement(UsageSettings, { api });
    return createElement('section', { className: 'dsh-governor-settings', 'aria-label': 'Governor 设置' }, createElement('header', null, createElement('div', null, createElement('p', null, 'MODEL GOVERNANCE'), createElement('h2', null, 'Governor')), createElement('span', null, access === null
        ? 'Host access…'
        : canManage
            ? `Host-managed · ${access.actorId}`
            : `Read-only · ${access.actorId}`)), createElement('nav', { 'aria-label': 'Governor 设置分区' }, tabs.map((item) => createElement('button', {
        key: item.key,
        type: 'button',
        className: tab === item.key ? 'active' : '',
        'aria-current': tab === item.key ? 'page' : undefined,
        onClick: () => setTab(item.key),
    }, item.label))), createElement('div', { className: 'dsh-governor-settings-body' }, accessError === null
        ? access === null
            ? createElement('p', { role: 'status' }, '正在确认 Host 权限…')
            : content
        : createElement(ErrorNotice, { error: accessError })));
}
const STYLES = `
.dsh-governor-model-select{display:inline-flex;align-items:center;gap:6px}.dsh-governor-model-select select,.dsh-governor-model-select input{max-width:250px;border:0;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);padding:5px 8px;font:inherit}.dsh-governor-model-select input{width:110px}.dsh-governor-model-select [role=status],.dsh-governor-model-select [role=alert]{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-governor-settings{color:var(--dsw-alias-label-primary)}.dsh-governor-settings>header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid var(--dsw-alias-border-l2);padding:6px 0 14px}.dsh-governor-settings>header p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:.14em}.dsh-governor-settings>header h2{margin:2px 0 0;font:600 25px/1.2 Georgia,serif}.dsh-governor-settings>header>span,.dsh-governor-readonly{font-size:12px;color:var(--dsw-alias-label-tertiary)}.dsh-governor-settings nav{display:flex;gap:4px;padding:14px 0}.dsh-governor-settings nav button,.dsh-governor-form button{border:0;border-radius:9px;background:transparent;color:inherit;padding:7px 12px;font:inherit;cursor:pointer}.dsh-governor-settings nav button:hover,.dsh-governor-settings nav button.active{background:var(--dsw-alias-interactive-bg-hover)}.dsh-governor-settings-body{min-height:280px}.dsh-governor-form{display:grid;max-width:420px;gap:14px}.dsh-governor-form label,.dsh-governor-user label{display:grid;gap:6px;font-size:13px}.dsh-governor-form input,.dsh-governor-form select,.dsh-governor-user input,.dsh-governor-table-wrap input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:8px}.dsh-governor-form button{justify-self:start;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2)}.dsh-governor-table-wrap{max-width:100%;overflow:auto}.dsh-governor-table-wrap table{width:100%;border-collapse:collapse;font-size:13px}.dsh-governor-table-wrap th,.dsh-governor-table-wrap td{text-align:left;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 8px;vertical-align:top}.dsh-governor-table-wrap small{display:block;color:var(--dsw-alias-label-tertiary)}.dsh-governor-user{display:grid;grid-template-columns:1fr 2fr auto;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;margin:0 0 10px;padding:12px}.dsh-governor-user legend{padding:0 5px}.dsh-governor-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.dsh-governor-metrics>div{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px}.dsh-governor-metrics strong,.dsh-governor-metrics span{display:block}.dsh-governor-metrics strong{font-size:22px}.dsh-governor-metrics span{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dsh-governor-error{border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);padding:8px 10px;font-size:12px}
.dsh-governor-quality{min-width:210px}.dsh-governor-quality summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.dsh-governor-quality label{display:grid;grid-template-columns:1fr 78px;align-items:center;gap:8px;margin-top:7px;font-size:11px}.dsh-governor-quality input{width:78px}
@media(max-width:600px){.dsh-governor-user{grid-template-columns:1fr}.dsh-governor-metrics{grid-template-columns:1fr}.dsh-governor-settings nav{overflow-x:auto}}
`;
function installStyles() {
    if (typeof document === 'undefined')
        return () => { };
    const selector = `style[data-plugin-css="${CLIENT_ID}"]`;
    if (document.querySelector(selector) !== null)
        return () => { };
    const tag = document.createElement('style');
    tag.dataset['plugin'] = CLIENT_ID;
    tag.dataset['pluginCss'] = CLIENT_ID;
    tag.textContent = STYLES;
    document.head.append(tag);
    return () => tag.remove();
}
/** Required rc.8 client services. */
export const inject = ['conversationEvents', 'modelDirectories', 'remote', 'sessions', 'slots'];
/** Mount all native Governor browser surfaces with one reversible lifecycle. */
export async function apply(ctx) {
    const browser = ctx;
    const slots = browser.slots;
    const disposers = [];
    try {
        const disposeRemote = await browser.remote.$mount(GOVERNOR_REMOTE_CONTRIBUTION);
        disposers.push(disposeRemote);
        // `$mount()` dynamically provides `remote.governor`.  Reading it through
        // `browser.remote.governor` makes Cordis treat the nested service as an
        // undeclared static dependency; declaring it in `inject` would instead
        // create a self-dependency because this plugin is the namespace owner.
        // `Context#get()` is the supported explicit lookup for a service created
        // during the current plugin's apply lifecycle.
        const governorRemote = ctx.get('remote.governor');
        if (governorRemote === undefined) {
            throw new Error('Governor Remote namespace did not become available after mount');
        }
        const api = createGovernorClientApi(governorRemote);
        disposers.push(installStyles());
        disposers.push(browser.conversationEvents.register(governorTrajectoryDefinition));
        disposers.push(slots.inject('conversation.input.model', () => slots.register({
            name: 'conversation.input.model',
            // rc.8 single-slot cells reject equal priorities and render the
            // lowest live priority.  The shipped selector uses the default 0;
            // Governor intentionally shadows it and its disposer reveals the
            // shipped entry again on HMR/uninstall.
            priority: -10,
            inject: (sessionId) => {
                const directory = browser.modelDirectories.directoryFor(sessionId);
                const available = browser.sessions.subagentAddress(sessionId) === undefined;
                return {
                    api,
                    available,
                    sessionId,
                    directory: directory.store,
                    load: () => {
                        if (available)
                            void directory.load().catch(() => { });
                    },
                    selectModel: (selection) => available
                        ? directory.select(selection).then(() => true, () => false)
                        : Promise.resolve(false),
                };
            },
        }, GovernorModelSelect)));
        disposers.push(slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'governor',
            order: 30,
            label: () => 'Governor',
            inject: () => ({ api }),
        }, GovernorSettings)));
    }
    catch (error) {
        for (const dispose of disposers.reverse()) {
            try {
                await dispose();
            }
            catch {
                // Preserve the setup failure; cleanup is best-effort for partial setup.
            }
        }
        throw error;
    }
    let disposed = false;
    return async () => {
        if (disposed)
            return;
        disposed = true;
        for (const dispose of disposers.reverse())
            await dispose();
    };
}
