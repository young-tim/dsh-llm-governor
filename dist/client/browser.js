import { createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { GOVERNOR_REMOTE_CONTRIBUTION, } from '../plugin/typert-remote-client.js';
import { TASK_TYPES } from '../index.js';
import { governorTrajectoryDefinition } from '../plugin/client-registration.js';
const CLIENT_ID = 'dsh-llm-governor';
const AUTO_VALUE = '__governor_auto__';
const AUTO_EFFORT_VALUE = '__governor_auto_effort__';
const AUTO_SETUP_HINT = 'Auto 未就绪：请先在 Settings → Governor → 模型中选择一个 Quality 快速档位。';
function isAutoQualityIssue(issue) {
    return issue.startsWith('Auto 尚未');
}
/**
 * Explicit onboarding presets. They align with Auto's default low / medium /
 * high quality gates without pretending to be measured benchmark results.
 */
export const QUALITY_PRESETS = [
    { score: 75, label: 'Lite', description: '省成本档' },
    { score: 85, label: '均衡', description: 'Flash / 标准档' },
    { score: 95, label: 'Pro', description: '高质量档' },
];
/** Suggest a visible, user-confirmed starting tier from conventional model names. */
export function suggestedQualityPreset(model) {
    const normalized = model.toLocaleLowerCase();
    if (/(?:^|[-_.\s])(lite|mini|nano|small)(?:$|[-_.\s])/.test(normalized))
        return 75;
    if (/(?:^|[-_.\s])(pro|max|ultra)(?:$|[-_.\s])/.test(normalized))
        return 95;
    return 85;
}
function qualityPresetPatch(score) {
    return {
        quality: Object.fromEntries(TASK_TYPES.map((taskType) => [taskType, score])),
    };
}
function configuredQualityTasks(rows) {
    const enabled = rows.filter((row) => row.enabled && row.available);
    return TASK_TYPES.filter((taskType) => enabled.some((row) => Number.isFinite(row.quality[taskType])));
}
/** Composer guard for Auto profiles that cannot cover every supported task yet. */
export function autoSetupIssue(rows) {
    if (!rows.some((row) => row.enabled)) {
        return 'Auto 尚未就绪：没有已启用模型。请打开 Settings → Governor → 模型。';
    }
    if (!rows.some((row) => row.enabled && row.available)) {
        return 'Auto 尚未就绪：没有可用的已启用模型。请打开 Settings → Governor → 模型。';
    }
    const coveredTasks = configuredQualityTasks(rows);
    if (coveredTasks.length < TASK_TYPES.length) {
        const missingTasks = TASK_TYPES.filter((taskType) => !coveredTasks.includes(taskType));
        return coveredTasks.length === 0
            ? 'Auto 尚未初始化：请打开 Settings → Governor → 模型，为可用的已启用模型选择快速档位。'
            : `Auto 尚未就绪：可用模型仅覆盖 ${String(coveredTasks.length)}/${String(TASK_TYPES.length)} 类 Quality（缺少：${missingTasks.join('、')}）。请打开 Settings → Governor → 模型补全覆盖。`;
    }
    return null;
}
function qualitySummary(row) {
    const scores = TASK_TYPES.flatMap((taskType) => {
        const score = row.quality[taskType];
        return score === undefined ? [] : [score];
    });
    if (scores.length === 0)
        return '未配置（Auto 不可用）';
    if (scores.length === TASK_TYPES.length && scores.every((score) => score === scores[0])) {
        return `全部任务 ${String(scores[0])}`;
    }
    return `${String(scores.length)}/${String(TASK_TYPES.length)} 项已配置`;
}
function modelAvailabilityMessage(row) {
    if (row.available)
        return null;
    return row.unavailableReason === 'credential_missing'
        ? 'Provider 凭证未配置，不参与自动路由'
        : 'Provider 可用性未知，不参与自动路由';
}
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
    const [autoIssue, setAutoIssue] = useState(undefined);
    const [query, setQuery] = useState('');
    const autoFallbackAttempt = useRef(null);
    useEffect(() => {
        if (!available)
            return;
        let live = true;
        setSelection(null);
        setAutoIssue(undefined);
        setError(null);
        autoFallbackAttempt.current = null;
        load();
        void api.selection(sessionId).then((next) => {
            if (live)
                setSelection(next);
        }, (cause) => {
            if (live)
                setError(String(cause));
        });
        void api.models().then((rows) => {
            if (live)
                setAutoIssue(autoSetupIssue(rows));
        }, (cause) => {
            if (live)
                setAutoIssue(`Auto 就绪状态检查失败：${String(cause)}`);
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
    const currentProvider = catalog.current?.provider;
    const currentModel = catalog.current?.model;
    const value = selection?.mode === 'auto' ? AUTO_VALUE : manualValue;
    const selectedChoice = choices.find((choice) => choice.value === manualValue);
    const reasoning = selectedChoice?.model.reasoning;
    const effectiveEffort = catalog.current?.reasoningEffort ?? reasoning?.defaultEffort ?? '';
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchingChoices = normalizedQuery === ''
        ? choices
        : choices.filter((choice) => `${choice.label} ${choice.model.id}`.toLocaleLowerCase().includes(normalizedQuery));
    const visibleChoices = selectedChoice === undefined || matchingChoices.some((choice) => choice.value === manualValue)
        ? matchingChoices
        : [selectedChoice, ...matchingChoices];
    const showFilter = choices.length > 8;
    const refreshAutoIssue = async () => {
        setAutoIssue(undefined);
        try {
            const nextIssue = autoSetupIssue(await api.models());
            setAutoIssue(nextIssue);
            return nextIssue;
        }
        catch (cause) {
            const nextIssue = `Auto 就绪状态检查失败：${String(cause)}`;
            setAutoIssue(nextIssue);
            return nextIssue;
        }
    };
    const onChange = async (next) => {
        if (selection === null || saving)
            return;
        setSaving(true);
        setError(null);
        try {
            if (next === AUTO_VALUE) {
                const setupIssue = await refreshAutoIssue();
                if (setupIssue !== null) {
                    throw new Error(isAutoQualityIssue(setupIssue) ? AUTO_SETUP_HINT : setupIssue);
                }
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
    useEffect(() => {
        if (!available ||
            locked ||
            saving ||
            selection?.mode !== 'auto' ||
            autoIssue === undefined ||
            autoIssue === null ||
            !isAutoQualityIssue(autoIssue) ||
            currentProvider === undefined ||
            currentModel === undefined) {
            return;
        }
        const route = `${currentProvider}:${currentModel}`;
        const attempt = `${sessionId}:${String(selection.selectionRevision)}:${route}`;
        if (autoFallbackAttempt.current === attempt)
            return;
        autoFallbackAttempt.current = attempt;
        let live = true;
        setSaving(true);
        setError(null);
        void api
            .selectMode(sessionId, 'manual', {
            expectedRevision: selection.selectionRevision,
            lastManualRoute: route,
        })
            .then((next) => {
            if (!live)
                return;
            setSelection(next);
            setError(`Auto 未就绪，已切换到 ${currentModel}。请在 Governor → 模型中选择 Quality 档位。`);
        }, (cause) => {
            if (live)
                setError(`Auto 未就绪且无法切换到当前模型：${String(cause)}`);
        })
            .finally(() => {
            if (live)
                setSaving(false);
        });
        return () => {
            live = false;
        };
    }, [api, autoIssue, available, currentModel, currentProvider, locked, selection, sessionId]);
    if (!available)
        return null;
    const autoActive = selection?.mode === 'auto';
    const activeAutoIssue = autoActive && autoIssue !== undefined && autoIssue !== null
        ? isAutoQualityIssue(autoIssue)
            ? AUTO_SETUP_HINT
            : autoIssue
        : null;
    const autoLabel = autoActive
        ? autoIssue === undefined
            ? 'Auto（Governor，检查中）'
            : autoIssue === null
                ? 'Auto（Governor）'
                : 'Auto（Governor，未就绪）'
        : 'Auto（Governor）';
    const displayedError = error ?? activeAutoIssue;
    const fallbackNotice = error?.startsWith('Auto 未就绪，已切换到 ') === true;
    return createElement('span', { className: 'dsh-governor-model-select' }, createElement('span', { className: 'dsh-governor-model-controls' }, showFilter
        ? createElement('input', {
            type: 'search',
            value: query,
            placeholder: '筛选模型',
            'aria-label': '筛选模型 / Filter models',
            disabled: locked || saving,
            onChange: (event) => setQuery(event.currentTarget.value),
        })
        : null, createElement('select', {
        'aria-label': '模型选择 / Model selection',
        'aria-invalid': activeAutoIssue === null ? undefined : activeAutoIssue !== undefined,
        disabled: locked || saving || selection === null,
        value,
        onFocus: () => {
            load();
            if (autoActive)
                void refreshAutoIssue();
        },
        onChange: (event) => {
            void onChange(event.currentTarget.value);
        },
    }, createElement('option', { value: AUTO_VALUE }, autoLabel), selectedChoice === undefined && manualValue !== ''
        ? createElement('option', { value: manualValue }, `${catalog.current?.model ?? ''} · ${catalog.current?.provider ?? ''}`)
        : null, visibleChoices.map((choice) => createElement('option', { key: choice.value, value: choice.value }, choice.label))), autoActive
        ? createElement('label', { className: 'dsh-governor-effort' }, createElement('span', null, '推理'), createElement('select', {
            'aria-label': '推理强度 / Reasoning effort',
            disabled: true,
            value: AUTO_EFFORT_VALUE,
        }, createElement('option', { value: AUTO_EFFORT_VALUE }, 'Auto 决定')))
        : reasoning === undefined
            ? null
            : createElement('label', { className: 'dsh-governor-effort' }, createElement('span', null, '推理'), createElement('select', {
                'aria-label': '推理强度 / Reasoning effort',
                disabled: locked || saving,
                value: effectiveEffort,
                onChange: (event) => {
                    void onEffortChange(event.currentTarget.value);
                },
            }, reasoning.defaultEffort === undefined
                ? createElement('option', { value: '' }, '提供方默认')
                : null, reasoning.efforts.map((effort) => createElement('option', { key: effort.id, value: effort.id }, effort.name)))), saving ? createElement('span', { role: 'status' }, '保存中…') : null), displayedError === null || displayedError === undefined
        ? null
        : createElement('span', {
            className: `dsh-governor-model-error${fallbackNotice ? ' notice' : ''}`,
            role: 'alert',
            title: displayedError,
        }, displayedError));
}
function ErrorNotice({ error }) {
    return error === null
        ? null
        : createElement('p', { className: 'dsh-governor-error', role: 'alert' }, error);
}
function RoutingSettings({ api, canManage }) {
    const [value, setValue] = useState(null);
    const [error, setError] = useState(null);
    const [saveStatus, setSaveStatus] = useState('idle');
    useEffect(() => {
        void api.routing().then(setValue, (cause) => setError(String(cause)));
    }, [api]);
    if (value === null)
        return createElement(ErrorNotice, { error: error ?? '正在加载路由策略…' });
    const save = async () => {
        setError(null);
        const minimumQuality = value.creditFirst.minimumQuality;
        if (!Number.isFinite(minimumQuality) || minimumQuality < 0 || minimumQuality > 100) {
            setSaveStatus('idle');
            setError('最低质量必须是 0–100 之间的数字。');
            return;
        }
        setSaveStatus('saving');
        try {
            setValue(await api.saveRouting({
                default: value.default,
                creditFirst: value.creditFirst,
                auto: value.auto,
                fallback: value.fallback,
            }, value.configRevision));
            setSaveStatus('saved');
        }
        catch (cause) {
            setSaveStatus('idle');
            setError(String(cause));
        }
    };
    return createElement('div', { className: 'dsh-governor-form' }, createElement('label', null, '默认模式', createElement('select', {
        value: value.default,
        disabled: !canManage,
        onChange: (event) => {
            setSaveStatus('idle');
            setValue({
                ...value,
                default: event.currentTarget.value,
            });
        },
    }, createElement('option', { value: 'manual' }, '手动'), createElement('option', { value: 'auto' }, '自动'), createElement('option', { value: 'quality_first' }, '质量优先'), createElement('option', { value: 'credit_first' }, '额度优先'))), createElement('label', null, '最低质量', createElement('input', {
        type: 'number',
        min: 0,
        max: 100,
        value: value.creditFirst.minimumQuality,
        disabled: !canManage,
        'aria-describedby': 'dsh-governor-minimum-quality-help',
        onChange: (event) => {
            setSaveStatus('idle');
            setValue({
                ...value,
                creditFirst: {
                    ...value.creditFirst,
                    minimumQuality: event.currentTarget.valueAsNumber,
                },
            });
        },
    }), createElement('small', { id: 'dsh-governor-minimum-quality-help' }, '可填 0–100，用于额度优先模式的最低 Quality 门槛。')), createElement('div', { className: 'dsh-governor-form-actions' }, createElement('button', {
        type: 'button',
        disabled: !canManage || saveStatus === 'saving',
        onClick: () => void save(),
    }, saveStatus === 'saving' ? '保存中…' : '保存路由设置'), saveStatus === 'saved'
        ? createElement('span', { role: 'status', 'aria-live': 'polite' }, '已保存')
        : saveStatus === 'saving'
            ? createElement('span', { role: 'status', 'aria-live': 'polite' }, '正在保存…')
            : null), createElement(ErrorNotice, { error }));
}
function ModelsSettings({ api, canManage }) {
    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let live = true;
        void api.models().then((value) => {
            if (live) {
                setRows(value);
                setLoading(false);
            }
        }, (cause) => {
            if (live) {
                setError(String(cause));
                setLoading(false);
            }
        });
        return () => {
            live = false;
        };
    }, [api]);
    const save = async (row, patch) => {
        setError(null);
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
    const coveredTasks = configuredQualityTasks(rows);
    const missingTasks = TASK_TYPES.filter((taskType) => !coveredTasks.includes(taskType));
    const hasEnabledModel = rows.some((row) => row.enabled);
    const hasAvailableEnabledModel = rows.some((row) => row.enabled && row.available);
    return createElement('div', null, createElement(ErrorNotice, { error }), createElement('section', {
        className: `dsh-governor-onboarding${missingTasks.length === 0 ? ' ready' : ''}`,
        'aria-label': 'Auto Quality 初始化状态',
    }, createElement('strong', null, missingTasks.length === 0
        ? 'Auto 已就绪 · 7/7 类任务有可用 Quality'
        : !hasEnabledModel
            ? '先启用一个可用模型，再使用 Auto'
            : !hasAvailableEnabledModel
                ? '没有可用的已启用模型，Auto 不可用'
                : coveredTasks.length === 0
                    ? '先初始化 Quality，再使用 Auto'
                    : `Auto 部分就绪 · ${String(coveredTasks.length)}/7 类任务已覆盖`), createElement('p', null, 'Quality 是模型间的相对档位，不要求先做精确测评。至少为一个可用的已启用模型选择 Lite 75、均衡 85 或 Pro 95，即可覆盖全部任务；未评分或 Provider 不可用的模型不会参与相应任务路由。'), missingTasks.length === 0
        ? null
        : createElement('small', null, `尚未覆盖：${missingTasks.join('、')}`)), loading
        ? createElement('p', { className: 'dsh-governor-empty', role: 'status' }, '正在加载模型…')
        : rows.length === 0 && error === null
            ? createElement('section', { className: 'dsh-governor-empty', 'aria-label': '模型空状态' }, createElement('strong', null, '暂无可配置模型'), createElement('p', null, '先在 DSH 中配置并启用模型，然后在这里设置 Governor 策略。'))
            : createElement('div', { className: 'dsh-governor-table-wrap dsh-governor-model-list' }, createElement('table', { className: 'dsh-governor-model-table' }, createElement('thead', null, createElement('tr', null, ['模型', '启用', '倍率', '能力', '质量'].map((label) => createElement('th', { key: label }, label)))), createElement('tbody', null, rows.map((row) => createElement('tr', {
                key: row.routeId,
                className: row.available ? undefined : 'unavailable',
            }, createElement('td', { className: 'dsh-governor-model-identity', title: row.routeId }, createElement('strong', null, row.model), createElement('small', null, row.provider), modelAvailabilityMessage(row) === null
                ? null
                : createElement('span', {
                    className: 'dsh-governor-model-availability',
                    'data-reason': row.unavailableReason ?? 'availability_check_failed',
                }, modelAvailabilityMessage(row))), createElement('td', { 'data-label': '启用' }, createElement('input', {
                type: 'checkbox',
                role: 'switch',
                checked: row.enabled,
                disabled: !canManage,
                'aria-label': `${row.routeId} 启用`,
                onChange: (event) => void save(row, { enabled: event.currentTarget.checked }),
            })), createElement('td', { 'data-label': '计费倍率' }, createElement('input', {
                type: 'number',
                min: 0,
                step: 0.01,
                defaultValue: row.multiplierPpm / 1_000_000,
                disabled: !canManage,
                'aria-label': `${row.routeId} 倍率`,
                onBlur: (event) => void save(row, { multiplier: event.currentTarget.valueAsNumber }),
            })), createElement('td', { 'data-label': '能力标签' }, createElement('input', {
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
            })), createElement('td', null, createElement('div', { className: 'dsh-governor-quality-presets' }, createElement('span', null, `快速档位 · 建议 ${String(suggestedQualityPreset(row.model))}`), createElement('div', null, QUALITY_PRESETS.map((preset) => createElement('button', {
                key: preset.score,
                type: 'button',
                disabled: !canManage,
                className: suggestedQualityPreset(row.model) === preset.score
                    ? 'suggested'
                    : undefined,
                title: `${preset.description}：把全部 7 类任务的初始 Quality 设为 ${String(preset.score)}`,
                'aria-label': `${row.routeId} 全部任务 Quality ${String(preset.score)}`,
                onClick: () => void save(row, qualityPresetPatch(preset.score)),
            }, `${preset.label} ${String(preset.score)}`))), createElement('small', null, '初始估计，可随时覆盖；不会自动后台改分')), createElement('details', { className: 'dsh-governor-quality' }, createElement('summary', null, `高级微调 · ${qualitySummary(row)}`), TASK_TYPES.map((taskType) => createElement('label', { key: taskType }, taskType, createElement('input', {
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
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let live = true;
        void api.users().then((value) => {
            if (live) {
                setRows(value);
                setLoading(false);
            }
        }, (cause) => {
            if (live) {
                setError(String(cause));
                setLoading(false);
            }
        });
        return () => {
            live = false;
        };
    }, [api]);
    const save = async (row, patch) => {
        setError(null);
        try {
            await api.saveUser(row.userId, patch, row.configRevision);
            setRows(await api.users());
        }
        catch (cause) {
            setError(String(cause));
        }
    };
    return createElement('div', null, createElement(ErrorNotice, { error }), loading
        ? createElement('p', { className: 'dsh-governor-empty', role: 'status' }, '正在加载用户策略…')
        : rows.length === 0 && error === null
            ? createElement('section', { className: 'dsh-governor-empty', 'aria-label': '用户策略空状态' }, createElement('strong', null, '暂无用户策略'), createElement('p', null, '当 Host 配置用户额度或模型允许列表后，用户会显示在这里。'))
            : null, rows.map((row) => createElement('fieldset', { key: row.userId, className: 'dsh-governor-user' }, createElement('legend', null, row.userId), createElement('label', null, '每月额度', createElement('input', {
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
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let live = true;
        void api.usage31Days().then((value) => {
            if (live) {
                setRows(value);
                setLoading(false);
            }
        }, (cause) => {
            if (live) {
                setError(String(cause));
                setLoading(false);
            }
        });
        return () => {
            live = false;
        };
    }, [api]);
    const totals = useMemo(() => {
        const requests = new Set(rows.map((row) => row.requestId)).size;
        const tokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
        const creditNanos = rows.reduce((sum, row) => sum + BigInt(row.creditNanos), 0n);
        return { requests, tokens, creditNanos };
    }, [rows]);
    return createElement('div', null, createElement('p', { className: 'dsh-governor-readonly' }, '只读 · 最近 31 天'), createElement(ErrorNotice, { error }), createElement('div', { className: 'dsh-governor-metrics' }, createElement('div', null, createElement('strong', null, String(totals.requests)), createElement('span', null, '请求')), createElement('div', null, createElement('strong', null, String(totals.tokens)), createElement('span', null, 'Tokens')), createElement('div', null, createElement('strong', { title: formatCreditNanos(totals.creditNanos.toString()) }, formatCreditNanos(totals.creditNanos.toString())), createElement('span', null, 'Credits'))), loading
        ? createElement('p', { className: 'dsh-governor-empty', role: 'status' }, '正在加载用量…')
        : rows.length === 0 && error === null
            ? createElement('section', { className: 'dsh-governor-empty', 'aria-label': '用量空状态' }, createElement('strong', null, '最近 31 天暂无用量记录'), createElement('p', null, '模型请求完成后，用量和回退记录会显示在这里。'))
            : createElement('div', { className: 'dsh-governor-table-wrap dsh-governor-usage-list' }, createElement('table', null, createElement('thead', null, createElement('tr', null, ['请求', '模型', 'Tokens', 'Credits', '时延', '结果'].map((label) => createElement('th', { key: label }, label)))), createElement('tbody', null, rows.map((row) => createElement('tr', { key: `${row.requestId}:${String(row.fallbackIndex)}` }, createElement('td', { 'data-label': '请求' }, createElement('code', { title: row.requestId }, row.requestId), createElement('small', null, `回退 #${String(row.fallbackIndex)}`)), createElement('td', { 'data-label': '模型', title: `${row.provider}:${row.model}` }, createElement('strong', null, row.model), createElement('small', null, row.provider)), createElement('td', { 'data-label': 'Tokens' }, String(row.inputTokens + row.outputTokens)), createElement('td', { 'data-label': 'Credits', title: formatCreditNanos(row.creditNanos) }, formatCreditNanos(row.creditNanos)), createElement('td', { 'data-label': '时延' }, `${row.latencyMs} ms`), createElement('td', { 'data-label': '结果' }, createElement('span', {
                className: `dsh-governor-result ${row.success ? 'success' : 'failure'}`,
            }, row.success ? '成功' : '失败'))))))));
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
.dsh-governor-model-select .dsh-governor-model-controls select,.dsh-governor-model-select .dsh-governor-model-controls input{font-family:inherit}.dsh-governor-model-select .dsh-governor-model-controls>select,.dsh-governor-model-select .dsh-governor-model-controls>input{height:28px;padding:4px 8px;font-size:13px;font-weight:500;line-height:20px}.dsh-governor-model-select .dsh-governor-model-controls>select option{font-size:13px;font-weight:500;line-height:20px}.dsh-governor-model-select .dsh-governor-model-controls>input{width:92px}.dsh-governor-model-select .dsh-governor-effort{font-size:12px;font-weight:400;line-height:18px}.dsh-governor-model-select .dsh-governor-effort select{height:26px;padding:3px 7px;font-size:12px;font-weight:400;line-height:18px}.dsh-governor-model-select .dsh-governor-effort select option{font-size:12px;font-weight:400;line-height:18px}.dsh-governor-model-select .dsh-governor-effort select:disabled{color:var(--dsw-alias-label-secondary);opacity:1;-webkit-text-fill-color:var(--dsw-alias-label-secondary)}
.dsh-governor-model-select{display:inline-grid;max-width:100%;gap:6px;vertical-align:middle}.dsh-governor-model-controls{display:flex;min-width:0;align-items:center;gap:6px;flex-wrap:wrap}.dsh-governor-model-controls select,.dsh-governor-model-controls input{box-sizing:border-box;max-width:250px;border:0;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);padding:5px 8px;font:inherit}.dsh-governor-model-controls input{width:92px}.dsh-governor-model-controls [role=status]{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dsh-governor-effort{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}.dsh-governor-effort select{color:var(--dsw-alias-label-primary);font-size:inherit}.dsh-governor-model-error{position:absolute;left:50%;bottom:calc(100% + 12px);z-index:30;box-sizing:border-box;display:block;width:max-content;max-width:min(520px,calc(100% - 24px));transform:translateX(-50%);border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-interactive-bg-hover-danger);box-shadow:0 10px 30px rgba(0,0,0,.18);color:var(--dsw-alias-state-error-primary);padding:8px 12px;font-size:12px;line-height:1.45;white-space:normal;overflow-wrap:anywhere;pointer-events:none}.dsh-governor-model-error.notice{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-secondary)}
.dsh-governor-settings{min-width:0;color:var(--dsw-alias-label-primary)}.dsh-governor-settings>header{display:flex;min-width:0;justify-content:space-between;align-items:end;gap:16px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:6px 0 14px}.dsh-governor-settings>header>div{min-width:0}.dsh-governor-settings>header p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:.14em}.dsh-governor-settings>header h2{margin:2px 0 0;font:600 23px/1.2 inherit}.dsh-governor-settings>header>span,.dsh-governor-readonly{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px}.dsh-governor-settings>header>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-governor-settings nav{display:flex;flex-wrap:wrap;gap:4px;padding:14px 0}.dsh-governor-settings nav button,.dsh-governor-form button{border:0;border-radius:8px;background:transparent;color:inherit;padding:7px 12px;font:inherit;cursor:pointer}.dsh-governor-settings nav button:hover,.dsh-governor-settings nav button.active{background:var(--dsw-alias-interactive-bg-hover)}.dsh-governor-settings button:focus-visible,.dsh-governor-settings input:focus-visible,.dsh-governor-settings select:focus-visible,.dsh-governor-settings summary:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}.dsh-governor-settings button:disabled{cursor:not-allowed;opacity:.55}.dsh-governor-settings-body{min-width:0;min-height:280px}.dsh-governor-form{display:grid;width:min(100%,420px);gap:14px}.dsh-governor-form label,.dsh-governor-user label{display:grid;min-width:0;gap:6px;font-size:13px}.dsh-governor-form label>small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}.dsh-governor-form input,.dsh-governor-form select,.dsh-governor-user input,.dsh-governor-table-wrap input{box-sizing:border-box;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:8px}.dsh-governor-form-actions{display:flex;align-items:center;gap:10px;min-height:34px}.dsh-governor-form-actions button{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2)}.dsh-governor-form-actions span{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));font-size:12px}.dsh-governor-error{max-width:100%;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);padding:8px 10px;font-size:12px;line-height:1.45;overflow-wrap:anywhere}.dsh-governor-empty{box-sizing:border-box;margin:10px 0;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:18px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}.dsh-governor-empty strong{display:block;color:var(--dsw-alias-label-primary);font-size:13px}.dsh-governor-empty p{margin:5px auto 0;max-width:520px;line-height:1.5}
.dsh-governor-onboarding{margin:0 0 12px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px}.dsh-governor-onboarding.ready{border-left-color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}.dsh-governor-onboarding strong,.dsh-governor-onboarding p,.dsh-governor-onboarding small{display:block}.dsh-governor-onboarding p{max-width:780px;margin:5px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}.dsh-governor-onboarding small{color:var(--dsw-alias-label-tertiary)}
.dsh-governor-table-wrap{width:100%;min-width:0;max-width:100%;overflow:visible}.dsh-governor-table-wrap table{width:100%;font-size:13px}.dsh-governor-table-wrap small{display:block;color:var(--dsw-alias-label-tertiary)}.dsh-governor-model-table,.dsh-governor-model-table tbody{display:block;border:0;border-collapse:separate}.dsh-governor-model-table thead,.dsh-governor-usage-list thead{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.dsh-governor-model-table tbody{display:grid;gap:10px}.dsh-governor-model-table tr{display:grid;grid-template-columns:minmax(140px,180px) minmax(180px,1fr) auto;gap:10px 12px;align-items:end;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:12px}.dsh-governor-model-table tr.unavailable{border-left:3px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));padding-left:10px}.dsh-governor-model-table td{min-width:0;border:0;padding:0;vertical-align:top}.dsh-governor-model-table td:first-child{grid-column:1/3;align-self:center}.dsh-governor-model-table td:nth-child(2){grid-column:3;grid-row:1;align-self:center}.dsh-governor-model-table td:nth-child(3){grid-column:1}.dsh-governor-model-table td:nth-child(4){grid-column:2/4}.dsh-governor-model-table td:nth-child(5){grid-column:1/-1;border-top:1px solid var(--dsw-alias-border-l2);padding-top:11px}.dsh-governor-model-table td[data-label]::before,.dsh-governor-usage-list td::before{display:block;margin-bottom:5px;color:var(--dsw-alias-label-tertiary);content:attr(data-label);font-size:10px;line-height:1.2}.dsh-governor-model-table td:nth-child(2)::before{display:inline;margin:0 7px 0 0}.dsh-governor-model-table td:nth-child(2) input{vertical-align:middle}.dsh-governor-model-table td:nth-child(3) input,.dsh-governor-model-table td:nth-child(4) input{width:100%}.dsh-governor-model-identity strong,.dsh-governor-model-identity small{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-governor-model-identity strong{font-size:14px}.dsh-governor-model-identity small{margin-top:2px}.dsh-governor-model-availability{display:block;width:fit-content;max-width:100%;margin-top:7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);padding:4px 7px;font-size:11px;line-height:1.35;white-space:normal}.dsh-governor-model-availability[data-reason=credential_missing]{background:var(--dsw-alias-state-warning-secondary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}.dsh-governor-quality-presets{min-width:0;margin-bottom:9px}.dsh-governor-quality-presets>span{display:block;margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-governor-quality-presets>div{display:flex;flex-wrap:wrap;gap:6px}.dsh-governor-quality-presets button{flex:0 1 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:5px 8px;font:inherit;font-size:11px;white-space:nowrap;cursor:pointer}.dsh-governor-quality-presets button:hover,.dsh-governor-quality-presets button.suggested{border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}.dsh-governor-quality-presets button:disabled{cursor:not-allowed;opacity:.5}.dsh-governor-quality-presets small{margin-top:5px;font-size:10px}.dsh-governor-quality{min-width:0}.dsh-governor-quality summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-governor-quality[open]{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:0 12px}.dsh-governor-quality[open] summary{grid-column:1/-1}.dsh-governor-quality label{display:grid;min-width:0;grid-template-columns:minmax(0,1fr) 68px;align-items:center;gap:7px;margin-top:8px;font-size:11px}.dsh-governor-quality input{width:68px}
.dsh-governor-user{display:grid;grid-template-columns:minmax(110px,.7fr) minmax(170px,1.5fr) auto;gap:12px;align-items:end;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;margin:0 0 10px;padding:12px}.dsh-governor-user legend{max-width:100%;padding:0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-governor-user output{padding:8px 0;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.dsh-governor-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}.dsh-governor-metrics>div{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px}.dsh-governor-metrics strong,.dsh-governor-metrics span{display:block}.dsh-governor-metrics strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:clamp(16px,3vw,22px);font-variant-numeric:tabular-nums;white-space:nowrap}.dsh-governor-metrics span{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-governor-usage-list table,.dsh-governor-usage-list tbody{display:block;border:0;border-collapse:separate}.dsh-governor-usage-list tbody{display:grid;gap:8px}.dsh-governor-usage-list tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:11px}.dsh-governor-usage-list td{min-width:0;border:0;padding:0;font-variant-numeric:tabular-nums}.dsh-governor-usage-list td>code,.dsh-governor-usage-list td>strong{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;color:inherit;font:inherit;font-weight:600;white-space:nowrap}.dsh-governor-usage-list td:nth-child(4){max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-governor-usage-list td:nth-child(5){white-space:nowrap}.dsh-governor-result{display:inline-block;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);padding:3px 7px;font-size:11px;white-space:nowrap}.dsh-governor-result.success{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}.dsh-governor-result.failure{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
@media(max-width:600px){.dsh-governor-settings>header{align-items:start;flex-direction:column;gap:6px}.dsh-governor-settings>header>span{max-width:100%}.dsh-governor-model-table tr{grid-template-columns:minmax(0,1fr) auto}.dsh-governor-model-table td:first-child{grid-column:1}.dsh-governor-model-table td:nth-child(2){grid-column:2}.dsh-governor-model-table td:nth-child(3),.dsh-governor-model-table td:nth-child(4),.dsh-governor-model-table td:nth-child(5){grid-column:1/-1}.dsh-governor-user{grid-template-columns:1fr}.dsh-governor-user output{padding:0}.dsh-governor-usage-list tr{grid-template-columns:repeat(2,minmax(0,1fr))}}
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
