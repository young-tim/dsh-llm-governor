/**
 * Routing 共享类型与错误码。
 */
import type { TaskType, Complexity, RoutingMode } from '../index.js';
import type { ModelSnapshot, CanonicalRoute } from '../model/canonical.js';
import type { UserAccessPolicy } from '../access/evaluator.js';

/** 稳定错误码（Routing + Audit/State + Revision/Auth + Recovery，见优化文档 7.2）。 */
export type RoutingErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'AMBIGUOUS_MODEL_ROUTE'
  | 'MODEL_DISABLED'
  | 'MODEL_ACCESS_DENIED'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'QUOTA_EXCEEDED'
  | 'NO_MODEL_MATCHED'
  | 'FALLBACK_EXHAUSTED'
  | 'PARTIAL_OUTPUT_NOT_RETRYABLE'
  | 'IDENTITY_REQUIRED'
  | 'AUDIT_PERSIST_FAILED'
  | 'DECISION_CONFLICT'
  | 'STORAGE_UNAVAILABLE'
  | 'PLUGIN_RELOADING'
  | 'RECOVERY_OWNER_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'SELECTION_REVISION_CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN';

/** Routing 错误。 */
export class RoutingError extends Error {
  readonly code: RoutingErrorCode;
  readonly routeId?: string;
  /** Evidence captured at the exact rejection point for durable diagnostics. */
  readonly evidence?: RoutingRejectionEvidence;
  constructor(
    code: RoutingErrorCode,
    message: string,
    routeId?: string,
    evidence?: RoutingRejectionEvidence,
  ) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    if (routeId !== undefined) this.routeId = routeId;
    if (evidence !== undefined) this.evidence = evidence;
  }
}

/** 排除原因码。 */
export type ExclusionReason =
  | 'disabled'
  | 'not_active_provider'
  | 'access_denied'
  | 'capability_not_supported'
  | 'excluded_in_request'
  | 'quality_missing'
  | 'quota_exceeded';

/** 候选项过滤后的结果。 */
export interface FilterResult {
  /** 通过过滤的候选。 */
  readonly candidates: ModelSnapshot[];
  /** 被排除的 route 及原因。 */
  readonly excluded: ReadonlyArray<{ routeId: CanonicalRoute; reason: ExclusionReason }>;
}

/** 候选过滤输入。 */
export interface FilterInput {
  /** 全部模型快照（advisory + 治理策略合并后）。 */
  readonly snapshots: readonly ModelSnapshot[];
  /** 活动 provider 集合。 */
  readonly activeProviders: ReadonlySet<string>;
  /** 全局默认可用 route 集合。 */
  readonly globalDefault: ReadonlySet<CanonicalRoute>;
  /** 用户策略（undefined=无用户策略）。 */
  readonly userPolicy: UserAccessPolicy | undefined;
  /** 本请求已排除的 route 集合。 */
  readonly excludedRoutes: ReadonlySet<CanonicalRoute>;
  /** 必须满足的能力列表。 */
  readonly requiredCapabilities: readonly string[];
  /** 必须满足的模态列表。 */
  readonly requiredModalities: readonly string[];
  /** Quota 准入检查：返回 true 表示允许。 */
  readonly quotaCheck: (routeId: CanonicalRoute) => boolean;
}

/** 决策候选信息（用于 Decision Record）。 */
export interface DecisionCandidate {
  readonly routeId: CanonicalRoute;
  readonly quality: number | undefined;
  readonly multiplierPpm: number;
}

/** Truthful candidate/exclusion snapshot retained when a strategy rejects. */
export interface RoutingRejectionEvidence {
  readonly candidates: readonly DecisionCandidate[];
  readonly excluded: ReadonlyArray<{ routeId: CanonicalRoute; reason: ExclusionReason }>;
  readonly minimumQuality?: number;
}

/** 决策记录。 */
export interface DecisionRecord {
  readonly requestId: string;
  readonly fallbackIndex: number;
  readonly mode: RoutingMode;
  readonly taskType?: TaskType;
  readonly complexity?: Complexity;
  readonly confidence?: number;
  readonly minimumQuality?: number;
  readonly candidates: readonly DecisionCandidate[];
  readonly excluded: ReadonlyArray<{ routeId: CanonicalRoute; reason: ExclusionReason }>;
  readonly selected: CanonicalRoute;
  readonly configRevision: number;
  readonly createdAt: string;
}

/** 路由选择结果。 */
export interface RoutingResult {
  readonly selected: ModelSnapshot;
  readonly decision: DecisionRecord;
}
