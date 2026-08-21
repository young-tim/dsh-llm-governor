import { RoutingError } from '../routing/types.js';
import { appendGovernorDecision, appendGovernorSelectionMode, findGovernorDecision, GOVERNOR_SESSION_EVENT_SCHEMA_VERSION, restoreGovernorSelection, } from '../dsh-adapter/session-events.js';
/**
 * 内存/测试用 Session Event sink：向给定 Session 幂等 append 并 flush。
 *
 * flush 是 durable acknowledgement 入口（SessionStore.flush 由接线层提供）。
 */
export class SessionStoreSink {
    _resolve;
    _flush;
    _sessions;
    constructor(resolve, flush, sessions) {
        this._resolve = resolve;
        this._flush = flush;
        this._sessions = sessions ?? (() => []);
    }
    /** 幂等追加决策事件并等待 durable ack。 */
    async appendDecision(decision, context) {
        const session = this._resolve(context.sessionId);
        if (session === undefined) {
            throw new RoutingError('AUDIT_PERSIST_FAILED', `session ${context.sessionId} not live for decision append`);
        }
        appendGovernorDecision(session, this._toEventData(decision));
        const participated = await this._flush(session);
        if (!participated) {
            throw new RoutingError('AUDIT_PERSIST_FAILED', `no durability listener participated for session ${context.sessionId}`);
        }
    }
    /** 查询 Session log 中是否已存在该决策事件。 */
    async hasDecision(decisionId) {
        for (const session of this._sessions()) {
            if (findGovernorDecision(session, decisionId) !== undefined)
                return true;
        }
        return false;
    }
    /** 幂等追加 selection-mode 事件并等待 durable ack。 */
    async appendSelectionMode(sessionId, data) {
        const session = this._resolve(sessionId);
        if (session === undefined) {
            throw new RoutingError('AUDIT_PERSIST_FAILED', `session ${sessionId} not live for selection-mode append`);
        }
        appendGovernorSelectionMode(session, data);
        const participated = await this._flush(session);
        if (!participated) {
            throw new RoutingError('AUDIT_PERSIST_FAILED', `no durability listener participated for session ${sessionId}`);
        }
    }
    /** 将 SealedDecision 映射为 Session Event 数据。 */
    _toEventData(decision) {
        return {
            schemaVersion: GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
            decisionId: decision.decisionId,
            decisionHash: decision.decisionHash,
            requestId: decision.requestId,
            turn: decision.turn,
            step: decision.step,
            fallbackIndex: decision.fallbackIndex,
            trigger: decision.trigger,
            causes: [...decision.causes],
            changedFields: [...decision.changedFields],
            selectionMode: decision.selectionMode,
            effectiveStrategy: decision.effectiveStrategy,
            ...(decision.classifier !== undefined ? { classification: decision.classifier } : {}),
            ...(decision.minimumQuality !== undefined ? { minimumQuality: decision.minimumQuality } : {}),
            candidates: decision.candidateTruncation.items.map((c) => ({
                routeId: c.routeId,
                ...(c.quality !== undefined ? { quality: c.quality } : {}),
                multiplierPpm: c.multiplierPpm,
            })),
            excluded: decision.excludedTruncation.items.map((e) => ({
                routeId: e.routeId,
                reason: e.reason,
            })),
            outcome: decision.outcome,
            ...(decision.selectedRoute !== undefined ? { selectedRoute: decision.selectedRoute } : {}),
            configRevision: decision.configRevision,
            ...(decision.errorCode !== undefined ? { errorCode: decision.errorCode } : {}),
            occurredAt: Date.now(),
        };
    }
}
/**
 * 严格 fail-closed sink：不写 Session Event 时直接抛 AUDIT_PERSIST_FAILED。
 *
 * 生产环境必须通过 mod.ts 注入 SessionStoreSink 以接通真实 DSH Session；
 * 此 sink 仅用于无 repository（audit 跳过）或显式故障注入场景。
 * 不再静默确认——不写轨迹就不能标 committed（GOV-TRACE-001 fail-closed）。
 */
export class NullSessionEventSink {
    /** 无 Session 写入：严格 fail-closed，抛错而非静默确认。 */
    async appendDecision() {
        throw new RoutingError('AUDIT_PERSIST_FAILED', 'NullSessionEventSink cannot provide durable ack — no Session Event written');
    }
    /** selection-mode 同样 fail-closed。 */
    async appendSelectionMode() {
        throw new RoutingError('AUDIT_PERSIST_FAILED', 'NullSessionEventSink cannot provide durable ack — no selection-mode event written');
    }
    /** 无事件写入，永远返回 false（对账走 SQLite 自身状态）。 */
    async hasDecision() {
        return false;
    }
}
/**
 * 双写审计管线：实现固定提交协议与启动对账。
 */
export class AuditPipeline {
    _repository;
    _sink;
    constructor(repository, sink) {
        this._repository = repository;
        this._sink = sink ?? new NullSessionEventSink();
    }
    /**
     * 提交一个决策：pending → Session Event（durable ack）→ committed。
     *
     * @param decision - 已 seal 的不可变决策。
     * @param context - 会话上下文（sessionId）。
     * @throws 任一步失败时抛 AUDIT_PERSIST_FAILED（fail closed，调用方不得分发 Provider）。
     */
    async commitDecision(decision, context) {
        if (this._repository === undefined)
            return;
        try {
            this._repository.insertSealedDecision(decision, context);
        }
        catch (err) {
            throw new RoutingError('AUDIT_PERSIST_FAILED', `decision ${decision.decisionId} sqlite persist failed: ${String(err)}`);
        }
        try {
            await this._sink.appendDecision(decision, context);
        }
        catch (err) {
            throw new RoutingError('AUDIT_PERSIST_FAILED', `decision ${decision.decisionId} session event append failed: ${String(err)}`);
        }
        const committed = this._repository.markDecisionCommitted(decision.decisionId, decision.decisionHash);
        if (!committed) {
            // 幂等重入（已 committed）或并发写入；确认最终状态后放行。
            const row = this._repository.getDecisions(decision.requestId, decision.fallbackIndex)[0];
            if (row?.auditState !== 'committed') {
                throw new RoutingError('AUDIT_PERSIST_FAILED', `decision ${decision.decisionId} compare-and-set to committed failed`);
            }
        }
    }
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
    async commitSelectionMode(sessionId, data) {
        if (this._repository === undefined)
            return;
        try {
            await this._sink.appendSelectionMode(sessionId, data);
        }
        catch (err) {
            if (err instanceof RoutingError && err.code === 'AUDIT_PERSIST_FAILED')
                throw err;
            throw new RoutingError('AUDIT_PERSIST_FAILED', `selection-mode event append failed for session ${sessionId}: ${String(err)}`);
        }
    }
    /**
     * 启动对账：扫描 pending 决策。
     * - Session Event 已存在且 hash 一致 → 补 commit。
     * - 不存在且 sink 可写 → 补 append 后 commit。
     * - 会话不可写或 hash 冲突 → 保留 pending、暴露告警，不自动分发。
     *
     * @returns 对账统计。
     */
    async reconcile() {
        if (this._repository === undefined)
            return { committed: 0, pending: 0, conflicts: [] };
        const result = { committed: 0, pending: 0, conflicts: [] };
        for (const row of this._repository.listPendingDecisions()) {
            if (row.decisionHash === undefined) {
                // 旧迁移行无 hash：保留 pending 由人工诊断。
                result.pending += 1;
                continue;
            }
            const exists = await this._sink.hasDecision(row.decisionId);
            if (!exists) {
                try {
                    await this._sink.appendDecision(this._reconstruct(row), {
                        sessionId: row.sessionId ?? 'unknown',
                    });
                }
                catch {
                    // 会话不可写：保留 pending（诊断视图显示“审计未完成”）。
                    result.pending += 1;
                    continue;
                }
            }
            if (this._repository.markDecisionCommitted(row.decisionId, row.decisionHash)) {
                result.committed += 1;
            }
            else {
                result.pending += 1;
            }
        }
        return result;
    }
    /** 从查询行重建 SealedDecision 形态（对账补 append 用）。 */
    _reconstruct(row) {
        return {
            decisionId: row.decisionId,
            decisionHash: row.decisionHash ?? '',
            requestId: row.requestId,
            turn: row.turn ?? 0,
            step: row.step ?? 0,
            fallbackIndex: row.fallbackIndex,
            trigger: (row.trigger ?? 'step'),
            causes: (row.causes ?? ['step']),
            changedFields: (row.changedFields ?? []),
            selectionMode: row.selectionMode ?? 'manual',
            effectiveStrategy: (row.effectiveStrategy ?? 'manual'),
            ...(row.taskType != null && row.complexity != null && row.confidence != null
                ? {
                    classifier: {
                        taskType: row.taskType,
                        complexity: row.complexity,
                        confidence: row.confidence,
                        source: (row.classifierSource ?? 'rule'),
                    },
                }
                : {}),
            ...(row.minimumQuality != null ? { minimumQuality: row.minimumQuality } : {}),
            candidates: row.candidates.map((c) => ({
                routeId: c.routeId,
                quality: c.quality,
                multiplierPpm: c.multiplierPpm,
            })),
            excluded: row.excluded,
            outcome: row.outcome,
            ...(row.selectedRoute != null ? { selectedRoute: row.selectedRoute } : {}),
            ...(row.errorCode != null ? { errorCode: row.errorCode } : {}),
            configRevision: row.configRevision,
            createdAt: row.createdAt,
            candidateTruncation: {
                items: row.candidates.map((c) => ({ ...c })),
                totalCount: row.candidates.length,
                truncated: false,
            },
            excludedTruncation: {
                items: row.excluded.map((e) => ({ ...e })),
                totalCount: row.excluded.length,
                truncated: false,
            },
        };
    }
}
/** 从 Session log 重建会话选择状态（restore 路径 helper，接线层使用）。 */
export function selectionFromSession(session) {
    return restoreGovernorSelection(session.events);
}
