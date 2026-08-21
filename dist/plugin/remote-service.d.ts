/**
 * DSH Typert Remote 的 Governor Host façade。
 *
 * 安全边界：所有公开方法都不接收 actor/user/role/capabilities；主体只能由
 * Host 注入的 GovernorPrincipalResolver 解析。local 模式可解析为进程所有者，
 * header/jwt/custom 模式在 Host 没有请求级 principal seam 时 fail closed。
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '../dsh-adapter/mod.js';
import type { GovernorCapability, GovernorPrincipalResolver } from '../security/governor-capabilities.js';
import type { ModelPolicyPatch, GovernorRoutingSettingsPatch, GovernorService, GovernorUsageQuery } from './service.js';
/** Remote 请求体上限（与兼容 API 相同）。 */
export declare const GOVERNOR_REMOTE_MAX_BYTES: number;
/** 向后兼容的 Remote 边界常量别名。 */
export declare const GOVERNOR_REMOTE_USAGE_MAX_DAYS = 31;
export declare const GOVERNOR_REMOTE_USAGE_MAX_ROWS = 200;
/** 每个 Remote 方法在 Host 端强制复核的最小能力。 */
export declare const GOVERNOR_REMOTE_CAPABILITIES: Readonly<{
    describeAccess: "governor.read";
    listModels: "governor.read";
    updateModel: "governor.manage";
    listUsers: "governor.read";
    updateUser: "governor.manage";
    getRouting: "governor.read";
    updateRouting: "governor.manage";
    queryUsage: "governor.read";
    getSessionSelectionMode: "governor.read";
    setSessionSelectionMode: "governor.manage";
    explainDecision: "governor.read";
    listAuditEntries: "governor.audit";
}>;
/** 浏览器可展示的 Usage DTO；BigInt 以十进制字符串跨越 JSON 边界。 */
export interface GovernorRemoteUsage {
    requestId: string;
    sessionId: string;
    userId: string;
    provider: string;
    model: string;
    routingMode: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    creditNanos: string;
    success: boolean;
    latencyMs: number;
    fallbackIndex: number;
    createdAt: string;
}
/**
 * 真实 Host Remote Service。`typertRemote` binding 由 TypertRemoteService 创建，
 * namespace 固定为 `governor`；严格 descriptors 见 typert-host.ts。
 */
export declare class GovernorRemoteService extends TypertRemoteService {
    private readonly governor;
    private readonly resolvePrincipal;
    constructor(ctx: Context, governor: GovernorService, resolvePrincipal: GovernorPrincipalResolver);
    /** Host 权限复核的唯一入口。 */
    private authorize;
    /** 统一执行权限复核与业务错误封装，确保 dispatchRpc 不降级成 internal。 */
    private execute;
    describeAccess(): Promise<{
        actorId: string;
        capabilities: GovernorCapability[];
    }>;
    listModels(): Promise<{
        multiplierPpm: number;
        capabilities: string[];
        quality: Readonly<Partial<Record<"general" | "coding" | "reasoning" | "writing" | "data_analysis" | "vision" | "tool_use", number>>>;
        configRevision: number;
        unavailableReason?: NonNullable<"credential_missing" | "availability_check_failed" | undefined>;
        routeId: string;
        provider: string;
        model: string;
        enabled: boolean;
        available: boolean;
    }[]>;
    updateModel(routeId: string, patch: ModelPolicyPatch, options?: {
        expectedRevision?: number;
    }): Promise<{
        routeId: string;
        provider: string;
        model: string;
        enabled: boolean;
        available: boolean;
        unavailableReason?: "credential_missing" | "availability_check_failed";
        multiplierPpm: number;
        capabilities: string[];
        quality: Partial<Record<import("../index.js").TaskType, number>>;
        configRevision: number;
    }>;
    listUsers(): Promise<{
        userId: string;
        allow: string[];
        monthlyCredits: number;
        usedCredits: number;
        usedCreditNanos: string;
        configRevision: number;
    }[]>;
    updateUser(userId: string, patch: {
        monthlyCredits?: number;
        allow?: string[];
    }, options?: {
        expectedRevision?: number;
    }): Promise<{
        userId: string;
        allow: string[];
        monthlyCredits: number;
        usedCredits: number;
        usedCreditNanos: string;
        configRevision: number;
    }>;
    getRouting(): Promise<import("./service.js").GovernorRoutingSettings>;
    updateRouting(patch: GovernorRoutingSettingsPatch, options?: {
        expectedRevision?: number;
    }): Promise<import("./service.js").GovernorRoutingSettings>;
    queryUsage(query: GovernorUsageQuery): Promise<GovernorRemoteUsage[]>;
    getSessionSelectionMode(sessionId: string): Promise<{
        mode: "auto" | "manual";
        lastManualRoute?: string;
        selectionRevision: number;
        isDefault: boolean;
    }>;
    setSessionSelectionMode(sessionId: string, mode: 'auto' | 'manual', options?: {
        expectedRevision?: number;
        lastManualRoute?: string;
        currentRoute?: string;
    }): Promise<{
        mode: "auto" | "manual";
        selectionRevision: number;
    }>;
    explainDecision(requestId: string, fallbackIndex?: number): Promise<import("../storage/repository.js").DecisionQueryResult[]>;
    listAuditEntries(limit: number): Promise<import("../storage/repository.js").AuditEntry[]>;
}
