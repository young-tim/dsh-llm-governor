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
 * rc.8 seam 阻断（docs/UPSTREAM_SEAMS.md SEAM-1/2，BLOCKED.md B-1）：持久化
 * Session 无法安全接收插件事件，因此默认使用 NullSessionEventSink（跳过
 * Session Event 写入，SQLite 审计仍为双阶段）；内存 Session 场景（测试）
 * 使用 SessionStoreSink 验证完整协议行为。
 */
import type { GovernorRepository } from '../storage/repository.js';
import type { SealedDecision } from '../routing/decision.js';
import type { Session } from '../dsh-adapter/mod.js';
import { type GovernorSessionSelectionState } from '../dsh-adapter/session-events.js';
/** Session Event 写入端抽象（双写协议的 Session 侧）。 */
export interface SessionEventSink {
    /** 幂等追加一条决策事件并返回 durable acknowledgement；失败抛错。 */
    appendDecision(decision: SealedDecision, context: {
        sessionId: string;
    }): Promise<void>;
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
    private readonly _listSessions;
    constructor(resolve: SessionResolver, flush: (session: Session) => Promise<boolean>, listSessions?: () => Session[]);
    /** 幂等追加决策事件并等待 durable ack。 */
    appendDecision(decision: SealedDecision, context: {
        sessionId: string;
    }): Promise<void>;
    /** 查询 Session log 中是否已存在该决策事件。 */
    hasDecision(decisionId: string): Promise<boolean>;
    /** 将 SealedDecision 映射为 Session Event 数据。 */
    private _toEventData;
}
/**
 * 默认 sink：rc.8 SEAM-1/2 阻断下不写 Session Event（fail safe，不破坏
 * DSH Session 持久化恢复），durable ack 直接满足，SQLite 双阶段照常。
 */
export declare class NullSessionEventSink implements SessionEventSink {
    /** 直接确认（无 Session Event 写入；见 BLOCKED.md B-1）。 */
    appendDecision(): Promise<void>;
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
