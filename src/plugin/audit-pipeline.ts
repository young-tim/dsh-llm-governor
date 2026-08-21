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
 * 注入 SessionStoreSink 以接通真实 DSH Session；新写入使用 rc.8 已知的
 * `request/context` carrier，真实持久化冷读与恢复均由合同测试覆盖。
 */
import type { GovernorRepository, DecisionQueryResult } from '../storage/repository.js';
import type { SealedDecision } from '../routing/decision.js';
import { RoutingError } from '../routing/types.js';
import type { Session } from '../dsh-adapter/mod.js';
import {
  appendGovernorDecision,
  appendGovernorSelectionMode,
  findGovernorDecision,
  governorDecisionFromEvent,
  GOVERNOR_SESSION_EVENT_SCHEMA_VERSION,
  restoreGovernorSelection,
  type GovernorSessionSelectionState,
  type GovernorSelectionModeEventData,
  type GovernorEventCarrierRoute,
} from '../dsh-adapter/session-events.js';

/** Session 审计事件的归属与 rc.8 `request/context` carrier route。 */
export interface SessionAuditContext {
  sessionId: string;
  /**
   * 当次 DSH 请求的真实 proposal/selected route。拒绝决策没有
   * selectedRoute，因此由调用方显式传入，禁止使用虚拟 provider/model。
   */
  route?: GovernorEventCarrierRoute;
}

/** Session Event 写入端抽象（双写协议的 Session 侧）。 */
export interface SessionEventSink {
  /** 幂等追加一条决策事件并返回 durable acknowledgement；失败抛错。 */
  appendDecision(decision: SealedDecision, context: SessionAuditContext): Promise<void>;
  /** 幂等追加一条 selection-mode 事件并返回 durable acknowledgement；失败抛错。 */
  appendSelectionMode(
    sessionId: string,
    data: GovernorSelectionModeEventData,
    route?: GovernorEventCarrierRoute,
  ): Promise<void>;
  /** 查询指定 decisionId 的 Session Event 是否已存在（对账用）。 */
  hasDecision(decisionId: string, expectedHash?: string): Promise<boolean>;
}

/** 写入决策事件时的会话查找函数（由接线层提供 session 解析）。 */
export type SessionResolver = (sessionId: string) => Session | undefined;

/**
 * 内存/测试用 Session Event sink：向给定 Session 幂等 append 并 flush。
 *
 * flush 是 durable acknowledgement 入口（SessionStore.flush 由接线层提供）。
 */
export class SessionStoreSink implements SessionEventSink {
  private readonly _resolve: SessionResolver;
  private readonly _flush: (session: Session) => Promise<boolean>;
  private readonly _sessions: () => Session[];

  constructor(
    resolve: SessionResolver,
    flush: (session: Session) => Promise<boolean>,
    sessions?: () => Session[],
  ) {
    this._resolve = resolve;
    this._flush = flush;
    this._sessions = sessions ?? (() => []);
  }

  /** 幂等追加决策事件并等待 durable ack。 */
  async appendDecision(decision: SealedDecision, context: SessionAuditContext): Promise<void> {
    const session = this._resolve(context.sessionId);
    if (session === undefined) {
      throw new RoutingError(
        'AUDIT_PERSIST_FAILED',
        `session ${context.sessionId} not live for decision append`,
      );
    }
    try {
      appendGovernorDecision(session, this._toEventData(decision), context.route);
    } catch (error) {
      if (String(error).includes('DECISION_CONFLICT')) {
        throw new RoutingError('DECISION_CONFLICT', String(error));
      }
      throw error;
    }
    const participated = await this._flush(session);
    if (!participated) {
      throw new RoutingError(
        'AUDIT_PERSIST_FAILED',
        `no durability listener participated for session ${context.sessionId}`,
      );
    }
  }

  /** 查询 Session log 中是否已存在该决策事件。 */
  async hasDecision(decisionId: string, expectedHash?: string): Promise<boolean> {
    for (const session of this._sessions()) {
      const event = findGovernorDecision(session, decisionId);
      if (event === undefined) continue;
      const actualHash = governorDecisionFromEvent(event)?.decisionHash;
      if (expectedHash !== undefined && actualHash !== expectedHash) {
        throw new RoutingError(
          'DECISION_CONFLICT',
          `decision ${decisionId} session hash ${String(actualHash)} conflicts with ${expectedHash}`,
        );
      }
      return true;
    }
    return false;
  }

  /** 幂等追加 selection-mode 事件并等待 durable ack。 */
  async appendSelectionMode(
    sessionId: string,
    data: GovernorSelectionModeEventData,
    route?: GovernorEventCarrierRoute,
  ): Promise<void> {
    const session = this._resolve(sessionId);
    if (session === undefined) {
      throw new RoutingError(
        'AUDIT_PERSIST_FAILED',
        `session ${sessionId} not live for selection-mode append`,
      );
    }
    appendGovernorSelectionMode(session, data, route);
    const participated = await this._flush(session);
    if (!participated) {
      throw new RoutingError(
        'AUDIT_PERSIST_FAILED',
        `no durability listener participated for session ${sessionId}`,
      );
    }
  }

  /** 将 SealedDecision 映射为 Session Event 数据。 */
  private _toEventData(decision: SealedDecision) {
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
export class NullSessionEventSink implements SessionEventSink {
  /** 无 Session 写入：严格 fail-closed，抛错而非静默确认。 */
  async appendDecision(): Promise<void> {
    throw new RoutingError(
      'AUDIT_PERSIST_FAILED',
      'NullSessionEventSink cannot provide durable ack — no Session Event written',
    );
  }

  /** selection-mode 同样 fail-closed。 */
  async appendSelectionMode(): Promise<void> {
    throw new RoutingError(
      'AUDIT_PERSIST_FAILED',
      'NullSessionEventSink cannot provide durable ack — no selection-mode event written',
    );
  }

  /** 无事件写入，永远返回 false（对账走 SQLite 自身状态）。 */
  async hasDecision(): Promise<boolean> {
    return false;
  }
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
export class AuditPipeline {
  private readonly _repository: GovernorRepository | undefined;
  private readonly _sink: SessionEventSink;

  constructor(repository: GovernorRepository | undefined, sink?: SessionEventSink) {
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
  async commitDecision(decision: SealedDecision, context: SessionAuditContext): Promise<void> {
    if (this._repository === undefined) return;
    try {
      this._repository.insertSealedDecision(decision, context);
    } catch (err) {
      throw new RoutingError(
        'AUDIT_PERSIST_FAILED',
        `decision ${decision.decisionId} sqlite persist failed: ${String(err)}`,
      );
    }
    try {
      await this._sink.appendDecision(decision, context);
    } catch (err) {
      if (err instanceof RoutingError && err.code === 'DECISION_CONFLICT') throw err;
      throw new RoutingError(
        'AUDIT_PERSIST_FAILED',
        `decision ${decision.decisionId} session event append failed: ${String(err)}`,
      );
    }
    const committed = this._repository.markDecisionCommitted(
      decision.decisionId,
      decision.decisionHash,
    );
    if (!committed) {
      // 幂等重入（已 committed）或并发写入；确认最终状态后放行。
      const row = this._repository.getDecisions(decision.requestId, decision.fallbackIndex)[0];
      if (row?.auditState !== 'committed') {
        throw new RoutingError(
          'AUDIT_PERSIST_FAILED',
          `decision ${decision.decisionId} compare-and-set to committed failed`,
        );
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
  async commitSelectionMode(
    sessionId: string,
    data: GovernorSelectionModeEventData,
    route?: GovernorEventCarrierRoute,
  ): Promise<void> {
    if (this._repository === undefined) return;
    try {
      await this._sink.appendSelectionMode(sessionId, data, route);
    } catch (err) {
      if (err instanceof RoutingError && err.code === 'AUDIT_PERSIST_FAILED') throw err;
      throw new RoutingError(
        'AUDIT_PERSIST_FAILED',
        `selection-mode event append failed for session ${sessionId}: ${String(err)}`,
      );
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
  async reconcile(): Promise<ReconcileResult> {
    if (this._repository === undefined) return { committed: 0, pending: 0, conflicts: [] };
    const result: ReconcileResult = { committed: 0, pending: 0, conflicts: [] };
    for (const row of this._repository.listPendingDecisions()) {
      if (row.decisionHash === undefined) {
        // 旧迁移行无 hash：保留 pending 由人工诊断。
        result.pending += 1;
        continue;
      }
      let exists: boolean;
      try {
        exists = await this._sink.hasDecision(row.decisionId, row.decisionHash);
      } catch (error) {
        if (error instanceof RoutingError && error.code === 'DECISION_CONFLICT') {
          result.conflicts.push(row.decisionId);
        }
        result.pending += 1;
        continue;
      }
      if (!exists) {
        try {
          await this._sink.appendDecision(this._reconstruct(row), {
            sessionId: row.sessionId ?? 'unknown',
          });
        } catch (error) {
          if (error instanceof RoutingError && error.code === 'DECISION_CONFLICT') {
            result.conflicts.push(row.decisionId);
          }
          // 会话不可写：保留 pending（诊断视图显示“审计未完成”）。
          result.pending += 1;
          continue;
        }
      }
      if (this._repository.markDecisionCommitted(row.decisionId, row.decisionHash)) {
        result.committed += 1;
      } else {
        result.pending += 1;
      }
    }
    return result;
  }

  /** 从查询行重建 SealedDecision 形态（对账补 append 用）。 */
  private _reconstruct(row: DecisionQueryResult): SealedDecision {
    return {
      decisionId: row.decisionId,
      decisionHash: row.decisionHash ?? '',
      requestId: row.requestId,
      turn: row.turn ?? 0,
      step: row.step ?? 0,
      fallbackIndex: row.fallbackIndex,
      trigger: (row.trigger ?? 'step') as SealedDecision['trigger'],
      causes: (row.causes ?? ['step']) as SealedDecision['causes'],
      changedFields: (row.changedFields ?? []) as SealedDecision['changedFields'],
      selectionMode: row.selectionMode ?? 'manual',
      effectiveStrategy: (row.effectiveStrategy ?? 'manual') as SealedDecision['effectiveStrategy'],
      ...(row.taskType != null && row.complexity != null && row.confidence != null
        ? {
            classifier: {
              taskType: row.taskType,
              complexity: row.complexity,
              confidence: row.confidence,
              source: (row.classifierSource ?? 'rule') as 'hint' | 'rule' | 'llm',
            },
          }
        : {}),
      ...(row.minimumQuality != null ? { minimumQuality: row.minimumQuality } : {}),
      candidates: row.candidates.map((c) => ({
        routeId: c.routeId,
        quality: c.quality,
        multiplierPpm: c.multiplierPpm,
      })),
      excluded: row.excluded as SealedDecision['excluded'],
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
        items: row.excluded.map((e) => ({ ...e })) as SealedDecision['excludedTruncation']['items'],
        totalCount: row.excluded.length,
        truncated: false,
      },
    };
  }
}

/** 从 Session log 重建会话选择状态（restore 路径 helper，接线层使用）。 */
export function selectionFromSession(session: Session): GovernorSessionSelectionState | undefined {
  return restoreGovernorSelection(session.events);
}
