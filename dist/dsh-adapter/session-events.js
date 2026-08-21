import { parseRoute } from '../model/canonical.js';
/** Governor Session Event 的 schema 版本（稳定码随版本演进，只增不改）。 */
export const GOVERNOR_SESSION_EVENT_SCHEMA_VERSION = 1;
/** 从新 carrier 或旧 governor/* envelope 读取统一决策 payload。 */
export function governorDecisionFromEvent(event) {
    if (event.type === 'governor/routing-decision')
        return event.data;
    return event.type === 'request/context' ? event.data.governorDecision : undefined;
}
/** 从新 carrier 或旧 governor/* envelope 读取统一选择状态 payload。 */
export function governorSelectionFromEvent(event) {
    if (event.type === 'governor/selection-mode')
        return event.data;
    return event.type === 'request/context' ? event.data.governorSelection : undefined;
}
/** 从明确 route、当前 context 或 header 中解析 carrier route。 */
function resolveCarrierRoute(session, preferred) {
    if (preferred !== undefined && preferred.provider.length > 0 && preferred.model.length > 0) {
        return preferred;
    }
    const context = session.requestContext();
    if (context !== undefined && context.provider.length > 0 && context.model.length > 0) {
        return { provider: context.provider, model: context.model };
    }
    const config = session.requestHeader()?.config;
    if (config !== undefined && config.provider.length > 0 && config.model.length > 0) {
        return { provider: config.provider, model: config.model };
    }
    throw new Error('Governor request/context carrier requires a real provider/model route');
}
/** 仅在 route 未变时保留 DSH 已解析的 contextWindow。 */
function matchingContextWindow(session, route) {
    const context = session.requestContext();
    return context?.provider === route.provider && context.model === route.model
        ? context.contextWindow
        : undefined;
}
/**
 * 幂等追加一条携带 `governorDecision` 投影的 `request/context` 事件。
 *
 * 持久层幂等实现：append 前扫描 session log，若已存在相同 decisionId 的事件
 * 则直接返回该事件，不产生第二条逻辑记录；decisionId 不同但 hash 相同属于
 * 上游冲突语义（由调用方抛 DECISION_CONFLICT）。同一进程内同一 decisionId
 * 的写入路径是串行的，扫描-追加窗口不存在并发竞争。
 *
 * @param session - 目标会话。
 * @param data - 决策事件数据。
 * @returns 追加（或已存在）的事件。
 */
export function appendGovernorDecision(session, data, carrierRoute) {
    const existing = findGovernorDecision(session, data.decisionId);
    if (existing !== undefined) {
        const existingData = existing.type === 'request/context' ? existing.data.governorDecision : existing.data;
        if (existingData.decisionHash !== data.decisionHash) {
            throw new Error(`DECISION_CONFLICT: ${data.decisionId}`);
        }
        if (existing.type === 'request/context')
            return existing;
        // 历史 governor/* seed 已有同 hash：不新增第二个逻辑事件。
        return existing;
    }
    const route = resolveCarrierRoute(session, carrierRoute ??
        (data.selectedRoute !== undefined
            ? parseRoute(data.selectedRoute)
            : data.candidates?.[0]?.routeId !== undefined
                ? parseRoute(data.candidates[0].routeId)
                : data.excluded?.[0]?.routeId !== undefined
                    ? parseRoute(data.excluded[0].routeId)
                    : undefined));
    const contextWindow = matchingContextWindow(session, route);
    return session.append('request/context', {
        ...route,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        governorDecision: data,
    });
}
/**
 * 幂等追加一条携带 `governorSelection` 投影的 `request/context` 事件。
 *
 * 同一 selectionRevision 的重复提交（保存确认重试、乱序回调）不产生第二条
 * 记录；revision 更大时正常追加。revision 回退由调用方（Host 持久化层）用
 * expected-revision 检查拒绝，这里不做静默覆盖。
 *
 * @param session - 目标会话。
 * @param data - 选择模式事件数据。
 * @returns 追加（或已存在）的事件。
 */
export function appendGovernorSelectionMode(session, data, carrierRoute) {
    const existing = findGovernorSelectionMode(session, data.selectionRevision);
    if (existing !== undefined) {
        if (existing.type === 'request/context')
            return existing;
        return existing;
    }
    const route = resolveCarrierRoute(session, carrierRoute ??
        (data.lastManualRoute !== undefined ? parseRoute(data.lastManualRoute) : undefined));
    const contextWindow = matchingContextWindow(session, route);
    return session.append('request/context', {
        ...route,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        governorSelection: data,
    });
}
/**
 * 在 session log 中查找指定 decisionId 的 Governor 决策事件。
 *
 * @param session - 目标会话。
 * @param decisionId - 幂等键 `<requestId>:<fallbackIndex>`。
 * @returns 已存在的事件；不存在返回 undefined。
 */
export function findGovernorDecision(session, decisionId) {
    for (const event of session.events) {
        const data = governorDecisionFromEvent(event);
        if (data?.decisionId !== decisionId)
            continue;
        if (event.type === 'governor/routing-decision')
            return event;
        if (event.type === 'request/context') {
            return event;
        }
    }
    return undefined;
}
/**
 * 在 session log 中查找指定 selectionRevision 的选择模式事件。
 *
 * @param session - 目标会话。
 * @param selectionRevision - 会话 selection 状态版本。
 * @returns 已存在的事件；不存在返回 undefined。
 */
export function findGovernorSelectionMode(session, selectionRevision) {
    for (const event of session.events) {
        const data = governorSelectionFromEvent(event);
        if (data?.selectionRevision !== selectionRevision)
            continue;
        if (event.type === 'governor/selection-mode')
            return event;
        if (event.type === 'request/context') {
            return event;
        }
    }
    return undefined;
}
/**
 * 从 session 事件流重建 Governor 会话选择状态（restore/fork 后的恢复路径）。
 *
 * 旧会话没有 selection-mode 事件时返回 undefined（调用方按全局默认初始化并
 * 在首次写入时升级），不从 Decision Event 反推模式。
 *
 * @param events - 会话事件流（持久 seed 或 live log 均可）。
 * @returns 重建的状态；无任何 selection-mode 事件时返回 undefined。
 */
export function restoreGovernorSelection(events) {
    let state;
    for (const event of events) {
        const data = governorSelectionFromEvent(event);
        if (data === undefined)
            continue;
        state = {
            mode: data.mode,
            selectionRevision: data.selectionRevision,
            ...(data.lastManualRoute !== undefined ? { lastManualRoute: data.lastManualRoute } : {}),
            ...(data.lastDecisionConfigRevision !== undefined
                ? { lastDecisionConfigRevision: data.lastDecisionConfigRevision }
                : {}),
        };
    }
    return state;
}
