/**
 * SQLite 数据仓库：模型策略、用户策略、白名单、身份绑定、决策、Usage、分类缓存的 CRUD。
 * Usage 和 Decision 的幂等通过主键保证；Decision 以 decisionId 为幂等键，
 * 同 ID 不同 hash 报 DECISION_CONFLICT（GOV-TRACE/DECISION）。
 */
import type { GovernorDatabase } from './database.js';
import type { TaskType, RoutingMode } from '../index.js';
import type { DecisionCandidate } from '../routing/types.js';
import type { SealedDecision } from '../routing/decision.js';
/** 模型策略行。 */
export interface ModelPolicyRow {
    routeId: string;
    provider: string;
    model: string;
    enabled: boolean;
    multiplierPpm: number;
    capabilities: string[];
    quality: Partial<Record<TaskType, number>>;
}
/** Usage 事件行。 */
export interface UsageEventRow {
    requestId: string;
    fallbackIndex: number;
    sessionId: string;
    usageKind?: 'conversation' | 'classifier';
    parentRequestId?: string;
    turn: number;
    step: number;
    userId: string;
    provider: string;
    model: string;
    routingMode: RoutingMode;
    taskType?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    creditNanos: bigint;
    success: boolean;
    finishKind?: string;
    errorCode?: string;
    httpStatus?: number;
    latencyMs: number;
    attemptOrigin: 'provider' | 'middleware_or_unknown';
    usageMissing: boolean;
    createdAt: string;
}
/** 决策查询结果：v2 起的统一公开 Decision 视图（旧行缺失字段为 unknown，不伪造）。 */
export interface DecisionQueryResult {
    decisionId: string;
    decisionHash?: string;
    requestId: string;
    sessionId?: string;
    turn?: number;
    step?: number;
    fallbackIndex: number;
    trigger?: string;
    causes?: string[];
    changedFields?: string[];
    selectionMode?: 'manual' | 'auto';
    effectiveStrategy?: string;
    classifierSource?: string;
    mode: RoutingMode;
    taskType?: string;
    complexity?: string;
    confidence?: number;
    minimumQuality?: number;
    candidates: DecisionCandidate[];
    candidateTruncated: boolean;
    candidateTotalCount?: number;
    excluded: Array<{
        routeId: string;
        reason: string;
    }>;
    excludedTruncated: boolean;
    excludedTotalCount?: number;
    outcome: 'selected' | 'rejected';
    selectedRoute?: string;
    errorCode?: string;
    auditState: 'pending' | 'committed';
    configRevision: number;
    createdAt: string;
}
/** 管理审计条目（GOV-SEC-001）。 */
export interface AuditEntry {
    id?: number;
    actor: string;
    action: string;
    target: string;
    changedFields?: string[];
    oldRevision?: number;
    newRevision?: number;
    result: 'success' | 'denied' | 'error';
    errorCode?: string;
    createdAt: string;
}
/** attempt 生命周期状态（GOV-ATTEMPT-001）。 */
export type AttemptState = 'not_dispatched' | 'dispatch_started' | 'completed' | 'failed' | 'cancelled' | 'indeterminate';
/**
 * Governor 数据仓库。封装所有 SQLite CRUD 操作。
 */
export declare class GovernorRepository {
    private readonly _db;
    constructor(db: GovernorDatabase);
    /** 插入或更新模型策略。 */
    upsertModelPolicy(row: ModelPolicyRow): void;
    /** 获取全部模型策略。 */
    listModelPolicies(): ModelPolicyRow[];
    /** 删除模型策略。 */
    deleteModelPolicy(routeId: string): void;
    /** 插入或更新用户策略。 */
    upsertUserPolicy(userId: string, monthlyCreditNanos: bigint): void;
    /** 获取用户额度。 */
    getUserQuota(userId: string): bigint | undefined;
    /** 获取全部用户 ID（按字典序）。 */
    listUserIds(): string[];
    /** 添加用户允许的 route。 */
    addUserAllow(userId: string, routeId: string): void;
    /** 获取用户允许的 route 列表。 */
    listUserAllow(userId: string): string[];
    /** 绑定 session 身份。 */
    upsertSessionIdentity(sessionId: string, userId: string, source: string, expiresAt?: number, displayName?: string, email?: string, attributes?: Record<string, unknown>): void;
    /** 获取 session 身份。 */
    getSessionIdentity(sessionId: string): {
        userId: string;
        source: string;
        expiresAt?: number;
    } | undefined;
    /** 插入不可变决策（audit_state=pending）。幂等：同 decisionId 同 hash 直接返回；不同 hash 抛 DECISION_CONFLICT。 */
    insertSealedDecision(decision: SealedDecision, context: {
        sessionId: string;
    }): 'inserted' | 'exists';
    /** 由 selectionMode/effectiveStrategy 推导 v1 兼容 mode 列。 */
    private _modeOf;
    /** 以 decisionId/hash compare-and-set 将 audit_state 置为 committed；状态或 hash 不匹配返回 false。 */
    markDecisionCommitted(decisionId: string, expectedHash: string): boolean;
    /** 启动对账：列出全部 pending 决策（按创建时间升序）。 */
    listPendingDecisions(): DecisionQueryResult[];
    /** 按 requestId 精确查询完整 attempt 集合；指定 fallbackIndex 时只返回一个 attempt。 */
    getDecisions(requestId: string, fallbackIndex?: number): DecisionQueryResult[];
    /** 将查询行映射为公开 Decision 视图（缺失字段不伪造）。 */
    private _rowToDecision;
    /** 列表分页查询：默认 50、最大 200、非精确查询最大时间范围 31 天。 */
    queryDecisions(opts: {
        sessionId?: string;
        from?: string;
        to?: string;
        limit?: number;
        cursor?: {
            createdAt: string;
            decisionId: string;
        };
    }): {
        items: DecisionQueryResult[];
        nextCursor?: {
            createdAt: string;
            decisionId: string;
        };
    };
    /** 读取全局单调递增 configRevision；未初始化返回 0（bootstrap 后为 1）。 */
    getConfigRevision(): number;
    /** 设置 configRevision（仅在配置事务内调用；与数据同事务提交）。 */
    setConfigRevision(revision: number): void;
    /** 保存 bootstrap 来源信息（hash 与时间；重启不得覆盖管理写入）。 */
    setBootstrapSource(source: string): void;
    /** 读取 bootstrap 来源。 */
    getBootstrapSource(): string | undefined;
    /** 写入审计条目（配置事务失败时随事务回滚）。 */
    insertAuditEntry(entry: AuditEntry): void;
    /** 查询审计条目（按时间倒序，分页）。 */
    listAuditEntries(limit: number): AuditEntry[];
    /** 读取分类缓存（input_hash 为 HMAC 复合键哈希；TTL 由调用方检查）。 */
    getClassifierCache(inputHash: string, configRevision: number): {
        taskType: string;
        complexity: string;
        confidence: number;
        source: string;
        createdAt: string;
    } | undefined;
    /** 写入分类缓存（幂等 UPSERT）。 */
    setClassifierCache(inputHash: string, configRevision: number, entry: {
        taskType: string;
        complexity: string;
        confidence: number;
        source: string;
    }): void;
    /** 读取 kv 值（HMAC key 等版本化合同数据）。 */
    getGovernorKv(key: string): string | undefined;
    /** 写入 kv 值（已存在时不覆盖，幂等初始化）。 */
    setGovernorKvIfAbsent(key: string, value: string): void;
    /** 幂等写入 attempt 状态（状态机收敛由调用方保证）。 */
    upsertAttemptState(requestId: string, fallbackIndex: number, state: AttemptState, providerRequestId?: string): void;
    /** 读取 attempt 状态。 */
    getAttemptState(requestId: string, fallbackIndex: number): AttemptState | undefined;
    /** 插入 Usage 事件（幂等：重复 request_id+fallback_index 忽略）。 */
    insertUsageEvent(row: UsageEventRow): void;
    /** 查询用户在指定时间范围内的已提交 Credits（bigint 求和）。 */
    sumUserCredits(userId: string, startTime: string, endTime: string): bigint;
    /** 查询 Usage 事件。 */
    queryUsage(opts: {
        userId?: string;
        provider?: string;
        usageKind?: 'conversation' | 'classifier';
        limit?: number;
    }): UsageEventRow[];
    /** GOV-USAGE-001 统计分母：Requests 以 requestId 去重，Attempts 以行数计。 */
    countUsageRequests(opts?: {
        usageKind?: 'conversation' | 'classifier';
    }): {
        requests: number;
        attempts: number;
    };
}
