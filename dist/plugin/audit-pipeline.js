import { RoutingError } from '../routing/types.js';
import { appendGovernorDecision, findGovernorDecision, GOVERNOR_SESSION_EVENT_SCHEMA_VERSION, restoreGovernorSelection, } from '../dsh-adapter/session-events.js';
/**
 * 内存/测试用 Session Event sink：向给定 Session 幂等 append 并 flush。
 *
 * flush 是 durable acknowledgement 入口（SessionStore.flush 由接线层提供）。
 */
export class SessionStoreSink {
    _resolve;
    _flush;
    _listSessions;
    constructor(resolve, flush, listSessions) {
        this._resolve = resolve;
        this._flush = flush;
        this._listSessions = listSessions ?? (() => []);
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
        for (const session of this._listSessions()) {
            if (findGovernorDecision(session, decisionId) !== undefined)
                return true;
        }
        return false;
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
            ...(decision.classifier !== undefined ? { classifier: decision.classifier } : {}),
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
            configRevision: decision.configRevision,
            ...(decision.errorCode !== undefined ? { errorCode: decision.errorCode } : {}),
            occurredAt: Date.now(),
        };
    }
}
/**
 * 默认 sink：rc.8 SEAM-1/2 阻断下不写 Session Event（fail safe，不破坏
 * DSH Session 持久化恢复），durable ack 直接满足，SQLite 双阶段照常。
 */
export class NullSessionEventSink {
    /** 直接确认（无 Session Event 写入；见 BLOCKED.md B-1）。 */
    async appendDecision() { }
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
