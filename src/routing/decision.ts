/**
 * 决策核心：UUIDv7 标识、RFC 8785 JCS 规范化哈希与不可变 Decision 的构造协议。
 *
 * GOV-TRACE/DECISION 公共基础：
 * - `decisionId = <requestId>:<fallbackIndex>` 是 Session Event 与 SQLite 双写的
 *   幂等键；同一 decisionId 收到不同 hash 必须报 DECISION_CONFLICT。
 * - `decisionHash` 对核心字段（schema/identity、turn/step/attempt、trigger/
 *   causes/changes、selection mode、strategy、classifier、minimum quality、
 *   候选、排除、路由结果、revision、安全错误码）做 JCS 规范化后计算
 *   SHA-256 小写十六进制；存储行号、写入时间等派生字段不参与比较。
 * - 截断：候选最多 64 项、排除最多 128 项、单个事件 UTF-8 序列化最多 64 KiB；
 *   按排序顺序截断并记录 totalCount/truncated 与截断摘要。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CanonicalRoute } from '../model/canonical.js';
import type { DecisionCandidate, ExclusionReason } from './types.js';

/** 规范常量：截断与序列化上限（版本化，见优化文档 7.1）。 */
export const DECISION_LIMITS = {
  /** 候选最多保存项数。 */
  maxCandidates: 64,
  /** 排除项最多保存项数。 */
  maxExcluded: 128,
  /** 单个 Decision Event 的 UTF-8 序列化上限（字节）。 */
  maxEventBytes: 64 * 1024,
} as const;

/** 允许出现在 changedFields 的固定枚举。 */
export const CHANGED_FIELDS = [
  'selection_mode',
  'strategy',
  'classification',
  'minimum_quality',
  'selected_route',
  'config_revision',
  'candidate_set',
] as const;

/** changedFields 的合法值类型。 */
export type ChangedField = (typeof CHANGED_FIELDS)[number];

/** trigger 兼容字段按该优先级取最高（causes 保存全部原因）。 */
export const TRIGGER_PRIORITY = [
  'fallback',
  'selection_mode_change',
  'config_change',
  'resume',
  'initial',
  'step',
] as const;

/** 决策原因（causes 元素）。 */
export type DecisionCause =
  'initial' | 'resume' | 'step' | 'selection_mode_change' | 'config_change' | 'fallback';

/**
 * 生成 UUIDv7（48 bit 毫秒时间戳 + 版本/变体位 + 随机位）。
 *
 * 用于 requestId：同一逻辑模型请求首次进入路由时生成，middleware 重入、
 * Fallback 与乱序回调复用同一 ID。
 *
 * @returns 小写十六进制 UUIDv7 字符串。
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const now = Date.now();
  // 48 bit 毫秒时间戳写入前 6 字节。
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // version 7。
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  // RFC 4122 variant。
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * RFC 8785 JSON Canonicalization Scheme 规范化。
 *
 * 对纯 JSON 值（string/number/boolean/null/array/object）递归按字典序排序
 * object key 后序列化；数字与字符串沿用 JSON.stringify 的 ECMAScript 语义
 * （与 RFC 8785 的 Number::toString / 字符串转义一致）。不支持 BigInt 等
 * 非 JSON 值（调用方保证输入为纯 JSON）。
 *
 * @param value - 纯 JSON 值。
 * @returns 规范化 JSON 文本。
 */
export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(value);
}

/** 递归序列化：object key 按 UTF-16 码元字典序排序。 */
function serializeCanonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serializeCanonical(item)).join(',')}]`;
      }
      const keys = Object.keys(value as Record<string, unknown>).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${serializeCanonical(entry)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`JCS: unsupported value type ${typeof value}`);
  }
}

/** 参与 decisionHash 比较的核心字段集合（双写一致性比较面）。 */
export interface DecisionHashInput {
  /** 事件 schema 版本。 */
  schemaVersion: number;
  /** 幂等键。 */
  decisionId: string;
  requestId: string;
  turn: number;
  step: number;
  fallbackIndex: number;
  trigger: string;
  causes: readonly string[];
  changedFields: readonly string[];
  selectionMode: string;
  effectiveStrategy: string;
  classifier?:
    { taskType: string; complexity: string; confidence: number; source: string } | undefined;
  minimumQuality?: number | undefined;
  candidates: readonly DecisionCandidate[];
  excluded: ReadonlyArray<{ routeId: string; reason: string }>;
  outcome: string;
  selectedRoute?: string | undefined;
  errorCode?: string | undefined;
  configRevision: number;
}

/**
 * 计算 decisionHash：核心字段 JCS 规范化后 SHA-256 小写十六进制。
 *
 * @param input - 参与比较的核心字段（截断后的最终形态）。
 * @returns 64 字符小写十六进制摘要。
 */
export function computeDecisionHash(input: DecisionHashInput): string {
  const canonical: Record<string, unknown> = {
    schemaVersion: input.schemaVersion,
    decisionId: input.decisionId,
    requestId: input.requestId,
    turn: input.turn,
    step: input.step,
    fallbackIndex: input.fallbackIndex,
    trigger: input.trigger,
    causes: [...input.causes],
    changedFields: [...input.changedFields],
    selectionMode: input.selectionMode,
    effectiveStrategy: input.effectiveStrategy,
    ...(input.classifier !== undefined ? { classifier: input.classifier } : {}),
    ...(input.minimumQuality !== undefined ? { minimumQuality: input.minimumQuality } : {}),
    candidates: input.candidates.map((c) => ({
      routeId: c.routeId,
      quality: c.quality,
      multiplierPpm: c.multiplierPpm,
    })),
    excluded: input.excluded.map((e) => ({ routeId: e.routeId, reason: e.reason })),
    outcome: input.outcome,
    ...(input.selectedRoute !== undefined ? { selectedRoute: input.selectedRoute } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    configRevision: input.configRevision,
  };
  return createHash('sha256').update(canonicalizeJson(canonical), 'utf8').digest('hex');
}

/** 截断后的候选/排除集合与截断元数据。 */
export interface TruncationResult<T> {
  /** 截断（或原样）后的列表。 */
  items: readonly T[];
  /** 截断前的总数。 */
  totalCount: number;
  /** 是否发生截断。 */
  truncated: boolean;
  /** 截断丢弃内容的 SHA-256 摘要（发生截断时存在）。 */
  truncatedDigest?: string;
}

/**
 * 按传入顺序截断列表并记录截断元数据。
 *
 * @param items - 原始列表（调用方保证已按决策排序顺序排列）。
 * @param max - 最大保留项数。
 * @returns 截断结果。
 */
export function truncateList<T>(items: readonly T[], max: number): TruncationResult<T> {
  if (items.length <= max) {
    return { items, totalCount: items.length, truncated: false };
  }
  const dropped = items.slice(max);
  return {
    items: items.slice(0, max),
    totalCount: items.length,
    truncated: true,
    truncatedDigest: createHash('sha256').update(canonicalizeJson(dropped), 'utf8').digest('hex'),
  };
}

/**
 * 按 causes 归并出兼容 trigger 字段（最高优先级胜出）。
 *
 * @param causes - 全部发生原因。
 * @returns 兼容 trigger。
 */
export function deriveTrigger(causes: readonly DecisionCause[]): (typeof TRIGGER_PRIORITY)[number] {
  for (const candidate of TRIGGER_PRIORITY) {
    if (causes.includes(candidate)) return candidate;
  }
  return 'step';
}

/**
 * 校验 changedFields 只允许固定枚举。
 *
 * @param fields - 待校验字段列表。
 * @throws 未知字段时抛错（fail closed）。
 */
export function assertChangedFields(
  fields: readonly string[],
): asserts fields is readonly ChangedField[] {
  for (const field of fields) {
    if (!(CHANGED_FIELDS as readonly string[]).includes(field)) {
      throw new Error(`DECISION_SCHEMA: unknown changedField ${field}`);
    }
  }
}

/** 构造完成的不可变决策（含哈希与截断元数据）。 */
export interface SealedDecision {
  /** 幂等键 `<requestId>:<fallbackIndex>`。 */
  decisionId: string;
  /** 核心字段 JCS SHA-256 摘要。 */
  decisionHash: string;
  requestId: string;
  turn: number;
  step: number;
  fallbackIndex: number;
  /** 兼容 trigger（causes 最高优先级）。 */
  trigger: (typeof TRIGGER_PRIORITY)[number];
  causes: readonly DecisionCause[];
  changedFields: readonly ChangedField[];
  selectionMode: 'manual' | 'auto';
  effectiveStrategy: 'manual' | 'quality_first' | 'credit_first';
  classifier?: {
    taskType: string;
    complexity: string;
    confidence: number;
    source: 'hint' | 'rule' | 'llm';
  };
  minimumQuality?: number;
  candidates: readonly DecisionCandidate[];
  excluded: ReadonlyArray<{ routeId: CanonicalRoute; reason: ExclusionReason }>;
  outcome: 'selected' | 'rejected';
  selectedRoute?: CanonicalRoute;
  errorCode?: string;
  configRevision: number;
  createdAt: string;
  /** 截断元数据。 */
  candidateTruncation: TruncationResult<DecisionCandidate>;
  excludedTruncation: TruncationResult<{ routeId: CanonicalRoute; reason: ExclusionReason }>;
}

/** 构造 SealedDecision 的输入（未截断的原始决策内容）。 */
export interface SealDecisionInput {
  requestId: string;
  turn: number;
  step: number;
  fallbackIndex: number;
  causes: readonly DecisionCause[];
  changedFields: readonly string[];
  selectionMode: 'manual' | 'auto';
  effectiveStrategy: 'manual' | 'quality_first' | 'credit_first';
  classifier?: {
    taskType: string;
    complexity: string;
    confidence: number;
    source: 'hint' | 'rule' | 'llm';
  };
  minimumQuality?: number;
  candidates: readonly DecisionCandidate[];
  excluded: ReadonlyArray<{ routeId: CanonicalRoute; reason: ExclusionReason }>;
  outcome: 'selected' | 'rejected';
  selectedRoute?: CanonicalRoute;
  errorCode?: string;
  configRevision: number;
}

/** 事件 schema 版本（与 GOVERNOR_SESSION_EVENT_SCHEMA_VERSION 对齐）。 */
export const DECISION_SCHEMA_VERSION = 1;

/**
 * 构造一个不可变决策：校验 changedFields、截断候选/排除、归并 trigger、
 * 计算 decisionHash，并 deepFreeze 全部字段。
 *
 * @param input - 原始决策内容。
 * @returns 冻结的 SealedDecision。
 */
export function sealDecision(input: SealDecisionInput): SealedDecision {
  assertChangedFields(input.changedFields);
  const candidateTruncation = truncateList(input.candidates, DECISION_LIMITS.maxCandidates);
  const excludedTruncation = truncateList(input.excluded, DECISION_LIMITS.maxExcluded);
  const decisionId = `${input.requestId}:${input.fallbackIndex}`;
  const trigger = deriveTrigger(input.causes);
  const decisionHash = computeDecisionHash({
    schemaVersion: DECISION_SCHEMA_VERSION,
    decisionId,
    requestId: input.requestId,
    turn: input.turn,
    step: input.step,
    fallbackIndex: input.fallbackIndex,
    trigger,
    causes: input.causes,
    changedFields: input.changedFields,
    selectionMode: input.selectionMode,
    effectiveStrategy: input.effectiveStrategy,
    classifier: input.classifier,
    minimumQuality: input.minimumQuality,
    candidates: candidateTruncation.items,
    excluded: excludedTruncation.items,
    outcome: input.outcome,
    selectedRoute: input.selectedRoute,
    errorCode: input.errorCode,
    configRevision: input.configRevision,
  });
  const sealed: SealedDecision = Object.freeze({
    decisionId,
    decisionHash,
    requestId: input.requestId,
    turn: input.turn,
    step: input.step,
    fallbackIndex: input.fallbackIndex,
    trigger,
    causes: Object.freeze([...input.causes]),
    changedFields: Object.freeze([...input.changedFields]),
    selectionMode: input.selectionMode,
    effectiveStrategy: input.effectiveStrategy,
    ...(input.classifier !== undefined
      ? { classifier: Object.freeze({ ...input.classifier }) }
      : {}),
    ...(input.minimumQuality !== undefined ? { minimumQuality: input.minimumQuality } : {}),
    candidates: Object.freeze(candidateTruncation.items.map((c) => Object.freeze({ ...c }))),
    excluded: Object.freeze(excludedTruncation.items.map((e) => Object.freeze({ ...e }))),
    outcome: input.outcome,
    ...(input.selectedRoute !== undefined ? { selectedRoute: input.selectedRoute } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    configRevision: input.configRevision,
    createdAt: new Date().toISOString(),
    candidateTruncation: Object.freeze({
      ...candidateTruncation,
      items: Object.freeze([...candidateTruncation.items]),
    }),
    excludedTruncation: Object.freeze({
      ...excludedTruncation,
      items: Object.freeze([...excludedTruncation.items]),
    }),
  });
  return sealed;
}

/**
 * 校验事件的 UTF-8 序列化大小不超过 64 KiB 上限。
 *
 * @param payload - 待序列化的事件数据。
 * @throws 超限时抛错（调用方须进一步截断后重试或 fail closed）。
 */
export function assertEventSize(payload: unknown): void {
  const size = Buffer.byteLength(canonicalizeJson(payload), 'utf8');
  if (size > DECISION_LIMITS.maxEventBytes) {
    throw new Error(
      `DECISION_SCHEMA: event exceeds ${DECISION_LIMITS.maxEventBytes} bytes (${size})`,
    );
  }
}
