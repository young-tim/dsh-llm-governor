/**
 * 四种确定性路由策略：Manual、Quality First、Credit First、Auto。
 * 所有策略共享公共候选过滤，使用稳定排序和固定 tie-break。
 */
import type { TaskType, Complexity, RoutingMode } from '../index.js';
import type { ModelSnapshot, CanonicalRoute } from '../model/canonical.js';
import { filterCandidates } from './filter.js';
import type {
  FilterInput,
  FilterResult,
  RoutingResult,
  DecisionRecord,
  DecisionCandidate,
  RoutingError as _RE,
} from './types.js';
import { RoutingError } from './types.js';

/** 生成随机 UUID。 */
function uuid(): string {
  return crypto.randomUUID();
}

/** 将候选转为 DecisionCandidate（用于 Decision Record）。 */
function toDecisionCandidates(
  candidates: readonly ModelSnapshot[],
  taskType?: TaskType,
): DecisionCandidate[] {
  return candidates.map((c) => ({
    routeId: c.routeId,
    quality: taskType ? c.quality[taskType] : undefined,
    multiplierPpm: c.multiplierPpm,
  }));
}

/** 构建决策记录。 */
function buildDecision(
  mode: RoutingMode,
  filterResult: FilterResult,
  selected: ModelSnapshot,
  taskType?: TaskType,
  complexity?: Complexity,
  confidence?: number,
  minimumQuality?: number,
  configRevision = 1,
): DecisionRecord {
  return {
    requestId: uuid(),
    fallbackIndex: 0,
    mode,
    ...(taskType != null ? { taskType } : {}),
    ...(complexity != null ? { complexity } : {}),
    ...(confidence != null ? { confidence } : {}),
    ...(minimumQuality != null ? { minimumQuality } : {}),
    candidates: toDecisionCandidates(filterResult.candidates, taskType),
    excluded: filterResult.excluded,
    selected: selected.routeId,
    configRevision,
    createdAt: new Date().toISOString(),
  };
}

// ===== Manual =====

/**
 * Manual 策略：读取用户选择的 provider/model，解析 canonical route 后只做公共过滤。
 * 成功时原样返回该 route；失败时拒绝，绝不自动替换成另一个模型。
 */
export function routeManual(
  input: FilterInput,
  requestedProvider: string,
  requestedModel: string,
  configRevision = 1,
): RoutingResult {
  const routeId: CanonicalRoute = `${requestedProvider}:${requestedModel}`;

  // 在 snapshots 中查找匹配的模型
  const snap = input.snapshots.find((s) => s.routeId === routeId);
  if (!snap) {
    throw new RoutingError('MODEL_NOT_FOUND', `model not found: ${routeId}`, routeId);
  }

  // 执行公共过滤（只检查这一个候选）
  const singleInput: FilterInput = { ...input, snapshots: [snap] };
  // DSH catalog 是自动候选资格源，不是 Provider 请求白名单：显式 Manual
  // 继续允许治理 policy 中保留、但当前 listModels 未列出的 route 直通。
  const filterResult = filterCandidates(singleInput, { allowUnlistedModels: true });

  if (filterResult.candidates.length === 0) {
    const reason = filterResult.excluded[0]?.reason ?? 'disabled';
    const code =
      reason === 'disabled'
        ? 'MODEL_DISABLED'
        : reason === 'provider_unavailable'
          ? 'PROVIDER_UNAVAILABLE'
          : reason === 'access_denied'
            ? 'MODEL_ACCESS_DENIED'
            : reason === 'capability_not_supported'
              ? 'CAPABILITY_NOT_SUPPORTED'
              : reason === 'quota_exceeded'
                ? 'QUOTA_EXCEEDED'
                : 'MODEL_NOT_FOUND';
    throw new RoutingError(code as _RE['code'], `model ${routeId} excluded: ${reason}`, routeId, {
      candidates: [],
      excluded: filterResult.excluded,
    });
  }

  const selected = filterResult.candidates[0]!;
  const decision = buildDecision(
    'manual',
    filterResult,
    selected,
    undefined,
    undefined,
    undefined,
    undefined,
    configRevision,
  );
  return { selected, decision };
}

// ===== Quality First =====

/**
 * Quality First 策略：对当前 task_type 的 Quality 降序排序。
 * Tie-break：1. Multiplier 升序 2. canonical route 字典序。
 * 缺少该 task Quality 的模型被排除为 quality_missing。
 */
export function routeQualityFirst(
  input: FilterInput,
  taskType: TaskType,
  configRevision = 1,
): RoutingResult {
  // 先公共过滤
  const baseResult = filterCandidates(input);

  // 再过滤缺少 quality 的模型
  const candidates: ModelSnapshot[] = [];
  const qualityExcluded: Array<{ routeId: CanonicalRoute; reason: 'quality_missing' }> = [];
  for (const snap of baseResult.candidates) {
    const q = snap.quality[taskType];
    if (q === undefined) {
      qualityExcluded.push({ routeId: snap.routeId, reason: 'quality_missing' });
    } else {
      candidates.push(snap);
    }
  }

  const allExcluded = [...baseResult.excluded, ...qualityExcluded];

  if (candidates.length === 0) {
    throw new RoutingError(
      'NO_MODEL_MATCHED',
      'no model with quality for task: ' + taskType,
      undefined,
      { candidates: [], excluded: allExcluded },
    );
  }

  // 稳定排序：Quality 降序 → Multiplier 升序 → route 字典序
  candidates.sort((a, b) => {
    const qa = a.quality[taskType]!;
    const qb = b.quality[taskType]!;
    if (qb !== qa) return qb - qa;
    if (a.multiplierPpm !== b.multiplierPpm) return a.multiplierPpm - b.multiplierPpm;
    return a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0;
  });

  const selected = candidates[0]!;
  const filterResult: FilterResult = { candidates, excluded: allExcluded };
  const decision = buildDecision(
    'quality_first',
    filterResult,
    selected,
    taskType,
    undefined,
    undefined,
    undefined,
    configRevision,
  );
  return { selected, decision };
}

// ===== Credit First =====

/**
 * Credit First 策略：先过滤 quality >= minimum_quality，再排序。
 * 排序：1. Multiplier 升序 2. Quality 降序 3. canonical route 字典序。
 * 无模型达标返回 NO_MODEL_MATCHED（除非配置 on_no_match: quality_first）。
 */
export function routeCreditFirst(
  input: FilterInput,
  taskType: TaskType,
  minimumQuality: number,
  configRevision = 1,
  onNoMatch: 'quality_first' | 'none' = 'none',
): RoutingResult {
  // 先公共过滤
  const baseResult = filterCandidates(input);

  // 过滤 quality >= minimum_quality
  const candidates: ModelSnapshot[] = [];
  const qualityExcluded: Array<{ routeId: CanonicalRoute; reason: 'quality_missing' }> = [];
  for (const snap of baseResult.candidates) {
    const q = snap.quality[taskType];
    if (q === undefined || q < minimumQuality) {
      qualityExcluded.push({ routeId: snap.routeId, reason: 'quality_missing' });
    } else {
      candidates.push(snap);
    }
  }

  const allExcluded = [...baseResult.excluded, ...qualityExcluded];

  if (candidates.length === 0) {
    if (onNoMatch === 'quality_first') {
      // 显式切换到 Quality First
      return routeQualityFirst({ ...input }, taskType, configRevision);
    }
    throw new RoutingError(
      'NO_MODEL_MATCHED',
      `no model meets minimum_quality ${minimumQuality} for task ${taskType}`,
      undefined,
      { candidates: [], excluded: allExcluded, minimumQuality },
    );
  }

  // 稳定排序：Multiplier 升序 → Quality 降序 → route 字典序
  candidates.sort((a, b) => {
    if (a.multiplierPpm !== b.multiplierPpm) return a.multiplierPpm - b.multiplierPpm;
    const qa = a.quality[taskType]!;
    const qb = b.quality[taskType]!;
    if (qb !== qa) return qb - qa;
    return a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0;
  });

  const selected = candidates[0]!;
  const filterResult: FilterResult = { candidates, excluded: allExcluded };
  const decision = buildDecision(
    'credit_first',
    filterResult,
    selected,
    taskType,
    undefined,
    undefined,
    minimumQuality,
    configRevision,
  );
  return { selected, decision };
}

// ===== Auto =====

/** Auto 分类结果。 */
export interface AutoClassification {
  taskType: TaskType;
  complexity: Complexity;
  confidence: number;
  source: 'hint' | 'rule' | 'llm';
}

/** 默认 quality 阈值。 */
const DEFAULT_QUALITY_THRESHOLDS = { low: 75, medium: 85, high: 92 };

/**
 * Auto 策略：按分类结果选择。
 * 低于置信度阈值时切 Quality First。
 * 置信度达标时映射复杂度到 minimum_quality，再执行 Credit First。
 */
export function routeAuto(
  input: FilterInput,
  classification: AutoClassification,
  confidenceThreshold: number,
  qualityThresholds: { low: number; medium: number; high: number } = DEFAULT_QUALITY_THRESHOLDS,
  configRevision = 1,
): RoutingResult {
  // 低置信度 → Quality First
  if (classification.confidence < confidenceThreshold) {
    const result = routeQualityFirst(input, classification.taskType, configRevision);
    // 修正决策中的分类信息
    return {
      selected: result.selected,
      decision: {
        ...result.decision,
        mode: 'auto',
        complexity: classification.complexity,
        confidence: classification.confidence,
      },
    };
  }

  // 置信度达标 → 映射复杂度到 minimum_quality，执行 Credit First
  const minQuality = qualityThresholds[classification.complexity];
  const result = routeCreditFirst(input, classification.taskType, minQuality, configRevision);

  // 修正决策中的分类信息
  return {
    selected: result.selected,
    decision: {
      ...result.decision,
      mode: 'auto',
      complexity: classification.complexity,
      confidence: classification.confidence,
    },
  };
}
