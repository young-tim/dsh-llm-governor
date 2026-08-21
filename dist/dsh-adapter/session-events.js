/** Governor Session Event 的 schema 版本（稳定码随版本演进，只增不改）。 */
export const GOVERNOR_SESSION_EVENT_SCHEMA_VERSION = 1;
/**
 * 幂等追加一条 `governor/routing-decision` 事件。
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
export function appendGovernorDecision(session, data) {
    const existing = findGovernorDecision(session, data.decisionId);
    if (existing !== undefined) {
        if (existing.data.decisionHash !== data.decisionHash) {
            throw new Error(`DECISION_CONFLICT: ${data.decisionId}`);
        }
        return existing;
    }
    return session.append('governor/routing-decision', data);
}
/**
 * 幂等追加一条 `governor/selection-mode` 事件。
 *
 * 同一 selectionRevision 的重复提交（保存确认重试、乱序回调）不产生第二条
 * 记录；revision 更大时正常追加。revision 回退由调用方（Host 持久化层）用
 * expected-revision 检查拒绝，这里不做静默覆盖。
 *
 * @param session - 目标会话。
 * @param data - 选择模式事件数据。
 * @returns 追加（或已存在）的事件。
 */
export function appendGovernorSelectionMode(session, data) {
    const existing = findGovernorSelectionMode(session, data.selectionRevision);
    if (existing !== undefined)
        return existing;
    return session.append('governor/selection-mode', data);
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
        if (event.type === 'governor/routing-decision' && event.data.decisionId === decisionId) {
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
        if (event.type === 'governor/selection-mode' &&
            event.data.selectionRevision === selectionRevision) {
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
        if (event.type !== 'governor/selection-mode')
            continue;
        state = {
            mode: event.data.mode,
            selectionRevision: event.data.selectionRevision,
            ...(event.data.lastManualRoute !== undefined
                ? { lastManualRoute: event.data.lastManualRoute }
                : {}),
            ...(event.data.lastDecisionConfigRevision !== undefined
                ? { lastDecisionConfigRevision: event.data.lastDecisionConfigRevision }
                : {}),
        };
    }
    return state;
}
