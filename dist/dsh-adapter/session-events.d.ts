/**
 * Governor 自有 Session Event：类型合并、幂等 append 与会话控制状态重建。
 *
 * 本模块是 rc.8 Session Event 接缝的 Governor 侧封装：
 * - 通过 declaration merge 向 `SessionEventMap` 注入 `governor/routing-decision`
 *   与 `governor/selection-mode` 两个纯信息事件（不参与消息重建）。
 * - 提供「扫描持久 log + append」的持久层幂等 append：rc.8 的
 *   `Session.append(type, data)` 没有幂等键参数，同一 decisionId 的重试必须由
 *   插件在持久层去重（见 docs/UPSTREAM_SEAMS.md SEAM-1/SEAM-2）。
 * - 提供从事件流重建 `governor.session.v1` 会话控制状态（selection mode）的
 *   纯函数，供 restore/fork 后恢复 Governor 选择模式。
 *
 * 注意：rc.8 `Session.append` 无法写入 envelope 级 `ignorable` 标记，因此这些
 * 事件一旦被持久化，冷读回会被 dsh-session-persistence 拒绝
 * （SessionFormatUnsupportedError）。合同测试 test/contracts/session-event-seams.test.ts
 * 固化了该红灯证据；在 seam 补齐前，Governor 不向可持久化会话写入这些事件。
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** Governor Session Event 的 schema 版本（稳定码随版本演进，只增不改）。 */
export declare const GOVERNOR_SESSION_EVENT_SCHEMA_VERSION = 1;
/**
 * `governor/routing-decision` 事件数据：一次路由计算的唯一不可变决策投影。
 * 纯信息记录：不参与 Prompt 或会话消息重建（非 surface 事件）。
 */
export interface GovernorRoutingDecisionEventData {
    /** 事件 schema 版本。 */
    schemaVersion: number;
    /** 幂等键：`<requestId>:<fallbackIndex>`，双写两侧共用。 */
    decisionId: string;
    /** RFC 8785 JCS 规范化后 SHA-256 的小写十六进制摘要。 */
    decisionHash: string;
    /** 同一逻辑模型请求的标识；middleware 重入/Fallback/乱序回调复用。 */
    requestId: string;
    /** 事件归属的 turn/step 与本 attempt 的 fallback 序号。 */
    turn: number;
    step: number;
    fallbackIndex: number;
    /** 兼容字段：causes 的最高优先级投影。 */
    trigger: 'initial' | 'resume' | 'step' | 'selection_mode_change' | 'config_change' | 'fallback';
    /** 全部发生原因（如 resume + selection_mode_change 同时出现）。 */
    causes: readonly string[];
    /** 精确变化字段，仅允许固定枚举集合。 */
    changedFields: readonly string[];
    /** 用户选择模式。 */
    selectionMode: 'manual' | 'auto';
    /** 实际执行策略。 */
    effectiveStrategy: 'manual' | 'quality_first' | 'credit_first';
    /** 分类结果（Auto 时存在）。 */
    classification?: {
        taskType: string;
        complexity: string;
        confidence: number;
        source: 'hint' | 'rule' | 'llm';
    };
    /** 该 attempt 使用的最低质量门槛。 */
    minimumQuality?: number;
    /** 候选集摘要（受 64 项截断限制）。 */
    candidates?: ReadonlyArray<{
        routeId: string;
        quality?: number;
        multiplierPpm: number;
    }>;
    /** 排除集摘要（受 128 项截断限制）。 */
    excluded?: ReadonlyArray<{
        routeId: string;
        reason: string;
    }>;
    /** 路由计算结果；selected 不代表 Provider 已调用。 */
    outcome: 'selected' | 'rejected';
    /** 决策使用的配置 revision。 */
    configRevision: number;
    /** 拒绝时的稳定错误码。 */
    errorCode?: string;
    /** 事件时间（毫秒）。 */
    occurredAt: number;
}
/**
 * `governor/selection-mode` 事件数据：用户切换 Auto/Manual 的会话控制状态变更。
 * 切换在 Host 持久化确认后生效并追加本事件（governor.session.v1 的 durable 投影）。
 */
export interface GovernorSelectionModeEventData {
    /** 事件 schema 版本。 */
    schemaVersion: number;
    /** 会话 selection 状态版本：每次成功切换递增，多标签页 expected-revision 冲突保护。 */
    selectionRevision: number;
    /** 切换后的模式。 */
    mode: 'auto' | 'manual';
    /** Manual 模式下最近一次手动选择；切回 Auto 时保留但不约束 Auto 结果。 */
    lastManualRoute?: string;
    /** 切换时已提交的最新决策配置 revision。 */
    lastDecisionConfigRevision?: number;
    /** 事件时间（毫秒）。 */
    changedAt: number;
}
/** 向 rc.8 SessionEventMap 注入 Governor 事件类型（与官方插件同一合并面）。 */
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'governor/routing-decision': GovernorRoutingDecisionEventData;
        'governor/selection-mode': GovernorSelectionModeEventData;
    }
}
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
export declare function appendGovernorDecision(session: Session, data: GovernorRoutingDecisionEventData): SessionEvent<'governor/routing-decision'>;
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
export declare function appendGovernorSelectionMode(session: Session, data: GovernorSelectionModeEventData): SessionEvent<'governor/selection-mode'>;
/**
 * 在 session log 中查找指定 decisionId 的 Governor 决策事件。
 *
 * @param session - 目标会话。
 * @param decisionId - 幂等键 `<requestId>:<fallbackIndex>`。
 * @returns 已存在的事件；不存在返回 undefined。
 */
export declare function findGovernorDecision(session: Session, decisionId: string): SessionEvent<'governor/routing-decision'> | undefined;
/**
 * 在 session log 中查找指定 selectionRevision 的选择模式事件。
 *
 * @param session - 目标会话。
 * @param selectionRevision - 会话 selection 状态版本。
 * @returns 已存在的事件；不存在返回 undefined。
 */
export declare function findGovernorSelectionMode(session: Session, selectionRevision: number): SessionEvent<'governor/selection-mode'> | undefined;
/** 从事件流重建的 `governor.session.v1` 会话控制状态。 */
export interface GovernorSessionSelectionState {
    /** 当前选择模式。 */
    mode: 'auto' | 'manual';
    /** 最近一次 Manual 选择（存在时便于切回；不约束 Auto 结果）。 */
    lastManualRoute?: string;
    /** 最新 selection 版本（expected-revision 冲突保护）。 */
    selectionRevision: number;
    /** 切换时已提交的最新决策配置 revision。 */
    lastDecisionConfigRevision?: number;
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
export declare function restoreGovernorSelection(events: readonly SessionEvent[]): GovernorSessionSelectionState | undefined;
