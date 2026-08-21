/**
 * 双写审计管线：pending → Session Event → committed 的固定提交协议（GOV-TRACE-001 §3.1）。
 *
 * 协议：
 * 1. SQLite 持久化 Decision（audit_state=pending）。
 * 2. 以相同 decisionId/hash 幂等 append Session Event，并等待 durable acknowledgement。
 * 3. SQLite 以 decisionId/hash compare-and-set 为 committed 并等待提交。
 * 4. 只有 committed 才允许 Provider 分发；任一步失败或超时 fail closed
 *    （AUDIT_PERSIST_FAILED），fake Provider 调用数为 0。
 *
 * 严格 fail-closed：NullSessionEventSink 在 appendDecision/appendSelectionMode 时
 * 抛 AUDIT_PERSIST_FAILED——不写轨迹就不能标 committed。生产接线（mod.ts apply）
 * 注入 SessionStoreSink 以接通真实 DSH Session；SEAM-1/2 阻断仅影响持久化冷读回
 * （docs/UPSTREAM_SEAMS.md），不影响内存 Session 的实时双写。
 */
import type { GovernorRepository } from '../storage/repository.js';
import type { SealedDecision } from '../routing/decision.js';
import type { Session } from '../dsh-adapter/mod.js';
import { type GovernorSessionSelectionState, type GovernorSelectionModeEventData } from '../dsh-adapter/session-events.js';
/** Session Event 写入端抽象（双写协议的 Session 侧）。 */
export interface SessionEventSink {
    /** 幂等追加一条决策事件并返回 durable acknowledgement；失败抛错。 */
    appendDecision(decision: SealedDecision, context: {
        sessionId: string;
    }): Promise<void>;
    /** 幂等追加一条 selection-mode 事件并返回 durable acknowledgement；失败抛错。 */
    appendSelectionMode(sessionId: string, data: GovernorSelectionModeEventData): Promise<void>;
    /** 查询指定 decisionId 的 Session Event 是否已存在（对账用）。 */
    hasDecision(decisionId: string): Promise<boolean>;
}
/** 写入决策事件时的会话查找函数（由接线层提供 session 解析）。 */
export type SessionResolver = (sessionId: string) => Session | undefined;
/**
 * 内存/测试用 Session Event sink：向给定 Session 幂等 append 并 flush。
 *
 * flush 是 durable acknowledgement 入口（SessionStore.flush 由接线层提供）。
 */
export declare class SessionStoreSink implements SessionEventSink {
    private readonly _resolve;
    private readonly _flush;
    private readonly _sessions;
    constructor(resolve: SessionResolver, flush: (session: Session) => Promise<boolean>, sessions?: () => Session[]);
    /** 幂等追加决策事件并等待 durable ack。 */
    appendDecision(decision: SealedDecision, context: {
        sessionId: string;
    }): Promise<void>;
    /** 查询 Session log 中是否已存在该决策事件。 */
    hasDecision(decisionId: string): Promise<boolean>;
    /** 幂等追加 selection-mode 事件并等待 durable ack。 */
    appendSelectionMode(sessionId: string, data: GovernorSelectionModeEventData): Promise<void>;
    /** 将 SealedDecision 映射为 Session Event 数据。 */
    private _toEventData;
}
/**
 * 严格 fail-closed sink：不写 Session Event 时直接抛 AUDIT_PERSIST_FAILED。
 *
 * 生产环境必须通过 mod.ts 注入 SessionStoreSink 以接通真实 DSH Session；
 * 此 sink 仅用于无 repository（audit 跳过）或显式故障注入场景。
 * 不再静默确认——不写轨迹就不能标 committed（GOV-TRACE-001 fail-closed）。
 */
export declare class NullSessionEventSink implements SessionEventSink {
    /** 无 Session 写入：严格 fail-closed，抛错而非静默确认。 */
    appendDecision(): Promise<void>;
    /** selection-mode 同样 fail-closed。 */
    appendSelectionMode(): Promise<void>;
    /** 无事件写入，永远返回 false（对账走 SQLite 自身状态）。 */
    hasDecision(): Promise<boolean>;
}
/** 对账结果。 */
export interface ReconcileResult {
    /** 补齐 committed 的决策数。 */
    committed: number;
    /** 保留 pending（会话不可写或 hash 冲突）的决策数。 */
    pending: number;
    /** hash 冲突明细（保留 pending 并暴露健康告警）。 */
    conflicts: string[];
}
/**
 * 双写审计管线：实现固定提交协议与启动对账。
 */
export declare class AuditPipeline {
    private readonly _repository;
    private readonly _sink;
    constructor(repository: GovernorRepository | undefined, sink?: SessionEventSink);
    /**
     * 提交一个决策：pending → Session Event（durable ack）→ committed。
     *
     * @param decision - 已 seal 的不可变决策。
     * @param context - 会话上下文（sessionId）。
     * @throws 任一步失败时抛 AUDIT_PERSIST_FAILED（fail closed，调用方不得分发 Provider）。
     */
    commitDecision(decision: SealedDecision, context: {
        sessionId: string;
    }): Promise<void>;
    /**
     * 追加 selection-mode 事件到 Session（durable ack 后生效）。
     *
     * selection-mode 事件是会话控制状态投影（governor.session.v1），不需要 SQLite
     * 审计行——它由 Session Event log 自身持久化。无 repository（内存模式）时跳过
     * （与 commitDecision 一致）；有 repository 时 sink 不可写 fail-closed
     * （抛 AUDIT_PERSIST_FAILED），调用方不得确认 UI 状态。
     *
     * @param sessionId - 会话 ID。
     * @param data - selection-mode 事件数据。
     * @throws sink 不可写时抛 AUDIT_PERSIST_FAILED。
     */
    commitSelectionMode(sessionId: string, data: GovernorSelectionModeEventData): Promise<void>;
    /**
     * 启动对账：扫描 pending 决策。
     * - Session Event 已存在且 hash 一致 → 补 commit。
     * - 不存在且 sink 可写 → 补 append 后 commit。
     * - 会话不可写或 hash 冲突 → 保留 pending、暴露告警，不自动分发。
     *
     * @returns 对账统计。
     */
    reconcile(): Promise<ReconcileResult>;
    /** 从查询行重建 SealedDecision 形态（对账补 append 用）。 */
    private _reconstruct;
}
/** 从 Session log 重建会话选择状态（restore 路径 helper，接线层使用）。 */
export declare function selectionFromSession(session: Session): GovernorSessionSelectionState | undefined;
