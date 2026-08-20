/**
 * SQLite 数据仓库：模型策略、用户策略、白名单、身份绑定、决策、Usage、分类缓存的 CRUD。
 * Usage 和 Decision 的幂等通过 PRIMARY KEY (request_id, fallback_index) 保证。
 */
import type { GovernorDatabase } from './database.js';
import type { TaskType, RoutingMode } from '../index.js';
import type { DecisionRecord } from '../routing/types.js';
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
    /** 插入决策记录（幂等：重复 request_id+fallback_index 忽略）。 */
    insertDecision(decision: DecisionRecord): void;
    /** 按 request_id 查询决策。 */
    getDecisions(requestId: string): DecisionRecord[];
    /** 插入 Usage 事件（幂等：重复 request_id+fallback_index 忽略）。 */
    insertUsageEvent(row: UsageEventRow): void;
    /** 查询用户在指定时间范围内的已提交 Credits（bigint 求和）。 */
    sumUserCredits(userId: string, startTime: string, endTime: string): bigint;
    /** 查询 Usage 事件。 */
    queryUsage(opts: {
        userId?: string;
        provider?: string;
        limit?: number;
    }): UsageEventRow[];
}
