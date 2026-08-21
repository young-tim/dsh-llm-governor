/**
 * Shared browser contracts for the Governor trajectory, Composer selector and
 * Settings surfaces.  `src/client/index.ts` consumes these definitions from a
 * real rc.8 `dsh.client` bundle; the host client-module registry discovers that
 * bundle from the live Loader package entry and owns its HMR lifecycle.
 */
import type {
  ConversationMatch,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ContextMessageNode,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client';
import {
  governorDecisionFromEvent,
  type GovernorRoutingDecisionEventData,
} from '../dsh-adapter/session-events.js';
import type { GovernorService } from './service.js';

/** Trajectory 卡片 Definition 的唯一 kind（会话引擎内的 Context 类别）。 */
const GOVERNOR_DECISION_KIND = 'governor-routing-decision';

/** Governor 决策直接贡献给官方 Trajectory target。 */
const GOVERNOR_DECISION_TARGET = 'trajectory';

interface GovernorTrajectoryViewNode extends ConversationViewNode {
  readonly target: 'trajectory';
  readonly anchorSeq: number;
  readonly location: ConversationLocation;
  readonly data: { readonly kind: 'node'; readonly node: ContextMessageNode };
}

/** Composer 单占位模型选择座席（ui-conversation SlotMap 声明，官方 occupant 之外）。 */
const GOVERNOR_MODEL_SEAT = 'conversation.input.model';

// ===== 卡片状态与视图模型（GOV-TRACE-002） =====

/** Trajectory 卡片状态：`start` 从一条 routing-decision 事件构建。 */
export interface GovernorDecisionCardState {
  readonly decisionId: string;
  readonly requestId: string;
  readonly turn: number | null;
  readonly step: number | null;
  readonly fallbackIndex: number;
  readonly selectionMode: 'auto' | 'manual' | 'unknown';
  readonly effectiveStrategy: 'manual' | 'quality_first' | 'credit_first' | 'unknown';
  readonly outcome: 'selected' | 'rejected' | 'unknown';
  readonly errorCode: string | null;
  readonly trigger: string | null;
  readonly causes: readonly string[];
  readonly changedFields: readonly string[];
  readonly classification: {
    readonly taskType: string;
    readonly complexity: string;
    readonly confidence: number;
    readonly source: string;
  } | null;
  readonly minimumQuality: number | null;
  readonly selectedRoute: string | null;
  readonly candidates: ReadonlyArray<{
    readonly routeId: string;
    readonly quality: number | null;
    readonly multiplierPpm: number | null;
  }>;
  readonly excluded: ReadonlyArray<{ readonly routeId: string; readonly reason: string }>;
  readonly configRevision: number | null;
  readonly occurredAt: number | null;
}

/** 卡片摘要（折叠态展示；GOV-TRACE-002：选择模式、模型、策略、倍率与原因）。 */
export interface GovernorDecisionCardSummary {
  readonly selectionMode: GovernorDecisionCardState['selectionMode'];
  readonly effectiveStrategy: GovernorDecisionCardState['effectiveStrategy'];
  readonly selectedRoute: string | null;
  readonly outcome: GovernorDecisionCardState['outcome'];
  readonly errorCode: string | null;
  /** 选择变化或拒绝的原因摘要（trigger/causes/changedFields/errorCode 投影）。 */
  readonly reason: string | null;
  readonly fallbackIndex: number;
  /** 所选模型的倍率与质量（selected 时从候选首位读取；缺失为 null → 显示「未知」）。 */
  readonly multiplierPpm: number | null;
  readonly quality: number | null;
}

/** 详情抽屉数据（GOV-TRACE-002：候选排序与排除原因，不默认展开全部 JSON）。 */
export interface GovernorDecisionCardDetail {
  readonly requestId: string;
  readonly turn: number | null;
  readonly step: number | null;
  readonly fallbackIndex: number;
  readonly classification: GovernorDecisionCardState['classification'];
  readonly minimumQuality: number | null;
  readonly candidates: GovernorDecisionCardState['candidates'];
  readonly excluded: GovernorDecisionCardState['excluded'];
  readonly configRevision: number | null;
  readonly causes: readonly string[];
  readonly changedFields: readonly string[];
}

/** 卡片视图节点数据：摘要 + 抽屉（浏览器组件消费的完整渲染模型）。 */
export interface GovernorDecisionCardViewData {
  readonly summary: GovernorDecisionCardSummary;
  readonly detail: GovernorDecisionCardDetail;
}

/** 卡片文案资源（GOV-TRACE-002 AC 2：中英文标签，不把内部枚举当 UI 文案）。 */
export const GOVERNOR_CARD_LABELS = {
  zh: {
    selectionMode: { auto: '自动选择', manual: '手动选择', unknown: '未知' },
    strategy: {
      manual: '手动',
      quality_first: '质量优先',
      credit_first: '额度优先',
      unknown: '未知',
    },
    outcome: { selected: '已选择', rejected: '已拒绝', unknown: '未知' },
  },
  en: {
    selectionMode: { auto: 'Auto', manual: 'Manual', unknown: 'Unknown' },
    strategy: {
      manual: 'Manual',
      quality_first: 'Quality First',
      credit_first: 'Credit First',
      unknown: 'Unknown',
    },
    outcome: { selected: 'Selected', rejected: 'Rejected', unknown: 'Unknown' },
  },
} as const;

/** 防御性字符串读取（旧 schema/缺失字段 → null，对应 UI 显示「未知」）。 */
function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 防御性数字读取（非有限数字 → null）。 */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 防御性只读数组读取（非数组 → 空数组）。 */
function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 事件数据 → 卡片状态（GOV-TRACE-002 AC 5：字段缺失或旧 schema 时取
 * `unknown`/`null`，不伪造值、不抛错破坏卡片挂载）。
 */
function toCardState(data: GovernorRoutingDecisionEventData): GovernorDecisionCardState {
  // 以 unknown 视角防御性读取：事件可能来自旧 schema 或被截断的持久化副本。
  const raw = data as unknown as Record<string, unknown>;
  const candidates = readArray(raw['candidates']).map((item) => {
    const c = (item ?? {}) as Record<string, unknown>;
    return {
      routeId: readString(c['routeId']) ?? 'unknown',
      quality: readNumber(c['quality']),
      multiplierPpm: readNumber(c['multiplierPpm']),
    };
  });
  const excluded = readArray(raw['excluded']).map((item) => {
    const e = (item ?? {}) as Record<string, unknown>;
    return {
      routeId: readString(e['routeId']) ?? 'unknown',
      reason: readString(e['reason']) ?? 'unknown',
    };
  });
  const classificationRaw = raw['classification'];
  const classification =
    classificationRaw !== null && typeof classificationRaw === 'object'
      ? (() => {
          const c = classificationRaw as Record<string, unknown>;
          const taskType = readString(c['taskType']);
          const complexity = readString(c['complexity']);
          const confidence = readNumber(c['confidence']);
          const source = readString(c['source']);
          if (taskType === null || complexity === null || confidence === null || source === null) {
            return null;
          }
          return { taskType, complexity, confidence, source };
        })()
      : null;
  const selectionMode = readString(raw['selectionMode']);
  const effectiveStrategy = readString(raw['effectiveStrategy']);
  const outcome = readString(raw['outcome']);
  return {
    decisionId: readString(raw['decisionId']) ?? 'unknown',
    requestId: readString(raw['requestId']) ?? 'unknown',
    turn: readNumber(raw['turn']),
    step: readNumber(raw['step']),
    fallbackIndex: readNumber(raw['fallbackIndex']) ?? 0,
    selectionMode:
      selectionMode === 'auto' || selectionMode === 'manual' ? selectionMode : 'unknown',
    effectiveStrategy:
      effectiveStrategy === 'manual' ||
      effectiveStrategy === 'quality_first' ||
      effectiveStrategy === 'credit_first'
        ? effectiveStrategy
        : 'unknown',
    outcome: outcome === 'selected' || outcome === 'rejected' ? outcome : 'unknown',
    errorCode: readString(raw['errorCode']),
    trigger: readString(raw['trigger']),
    causes: readArray(raw['causes']).filter((c): c is string => typeof c === 'string'),
    changedFields: readArray(raw['changedFields']).filter(
      (f): f is string => typeof f === 'string',
    ),
    classification,
    minimumQuality: readNumber(raw['minimumQuality']),
    selectedRoute: readString(raw['selectedRoute']),
    candidates,
    excluded,
    configRevision: readNumber(raw['configRevision']),
    occurredAt: readNumber(raw['occurredAt']),
  };
}

/** 从候选列表读取所选路由的倍率与质量（selected 时候选首位即所选）。 */
function selectedRouteMetrics(state: GovernorDecisionCardState): {
  multiplierPpm: number | null;
  quality: number | null;
} {
  if (state.selectedRoute === null) return { multiplierPpm: null, quality: null };
  const top = state.candidates[0];
  if (top === undefined || top.routeId !== state.selectedRoute) {
    return { multiplierPpm: null, quality: null };
  }
  return { multiplierPpm: top.multiplierPpm, quality: top.quality };
}

/** 构建选择变化或拒绝的原因摘要（trigger 优先，rejected 附带错误码）。 */
function buildReason(state: GovernorDecisionCardState): string | null {
  const parts: string[] = [];
  if (state.trigger !== null) parts.push(state.trigger);
  for (const cause of state.causes) {
    if (cause !== state.trigger) parts.push(cause);
  }
  if (state.outcome === 'rejected' && state.errorCode !== null) {
    parts.push(state.errorCode);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** 卡片状态 → 视图数据（摘要 + 抽屉）。 */
function buildCardViewData(state: GovernorDecisionCardState): GovernorDecisionCardViewData {
  const metrics = selectedRouteMetrics(state);
  return {
    summary: {
      selectionMode: state.selectionMode,
      effectiveStrategy: state.effectiveStrategy,
      selectedRoute: state.selectedRoute,
      outcome: state.outcome,
      errorCode: state.errorCode,
      reason: buildReason(state),
      fallbackIndex: state.fallbackIndex,
      multiplierPpm: metrics.multiplierPpm,
      quality: metrics.quality,
    },
    detail: {
      requestId: state.requestId,
      turn: state.turn,
      step: state.step,
      fallbackIndex: state.fallbackIndex,
      classification: state.classification,
      minimumQuality: state.minimumQuality,
      candidates: state.candidates,
      excluded: state.excluded,
      configRevision: state.configRevision,
      causes: state.causes,
      changedFields: state.changedFields,
    },
  };
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  initial: '初始请求',
  selection_mode_change: '选择模式变更',
  fallback: 'Fallback 重试',
  config_change: '配置变更',
  step: '新步骤',
  NO_MODEL_MATCHED: '没有匹配模型',
  quality_missing: '缺少任务 Quality',
  disabled: '模型已禁用',
  access_denied: '无访问权限',
  capability_not_supported: '能力不匹配',
  quota_exceeded: '额度已耗尽',
  excluded_in_request: '本次请求已排除',
};

function reasonLabel(value: string): string {
  const label = REASON_LABELS[value];
  return label === undefined ? value : `${label} (${value})`;
}

function knownMetric(value: number | null, suffix = ''): string {
  return value === null ? '未知' : `${String(value)}${suffix}`;
}

/** Format the decision as a native Trajectory context notice. */
function decisionMarkdown(state: GovernorDecisionCardState): string {
  const { summary, detail } = buildCardViewData(state);
  const labels = GOVERNOR_CARD_LABELS.zh;
  const location = `Turn ${detail.turn === null ? '未知' : String(detail.turn)} · Step ${
    detail.step === null ? '未知' : String(detail.step)
  }`;
  const lines = [
    `**Governor 路由 · ${location}**`,
    `状态：${labels.outcome[summary.outcome]} · 模式：${labels.selectionMode[summary.selectionMode]} · 策略：${labels.strategy[summary.effectiveStrategy]}`,
    `模型：${summary.selectedRoute ?? '未选择'} · Quality：${knownMetric(summary.quality)} · 倍率：×${knownMetric(summary.multiplierPpm === null ? null : summary.multiplierPpm / 1_000_000)} · Fallback：${String(summary.fallbackIndex)}`,
  ];
  if (summary.reason !== null) {
    lines.push(`原因：${summary.reason.split(', ').map(reasonLabel).join('、')}`);
  }
  if (detail.classification !== null) {
    lines.push(
      `分类：${detail.classification.taskType} / ${detail.classification.complexity} / ${Math.round(detail.classification.confidence * 100)}% (${detail.classification.source})`,
    );
  }
  if (detail.minimumQuality !== null) {
    lines.push(`最低 Quality：${String(detail.minimumQuality)}`);
  }
  lines.push('', '候选排序：');
  if (detail.candidates.length === 0) lines.push('- 无');
  else {
    for (const candidate of detail.candidates) {
      lines.push(
        `- ${candidate.routeId} · Q ${knownMetric(candidate.quality)} · ×${knownMetric(candidate.multiplierPpm === null ? null : candidate.multiplierPpm / 1_000_000)}`,
      );
    }
  }
  if (detail.excluded.length > 0) {
    lines.push('', '已排除：');
    for (const item of detail.excluded) {
      lines.push(`- ${item.routeId} · ${reasonLabel(item.reason)}`);
    }
  }
  lines.push(
    '',
    `Request ID：${detail.requestId}`,
    `Revision：${knownMetric(detail.configRevision)}`,
  );
  return lines.join('\n');
}

/**
 * Governor 轨迹卡片 Definition：匹配 rc.8 兼容的
 * `request/context.data.governorDecision`，并保留旧 `governor/routing-decision`
 * 的只读兼容，
 * 为每个 decisionId 建立独立 Context，`buildViewNode` 产出官方 Trajectory
 * 可消费的 context notice，不再注册平行的 Governor 页签。
 *
 * 事件是纯信息记录且自包含（无 update 事件）：`update` 恒返回既有状态；
 * 相同 route 的重复决策拥有不同 decisionId，各自成卡（折叠是渲染层行为）。
 */
export const governorTrajectoryDefinition: ConversationNodeDefinition<GovernorDecisionCardState> = {
  kind: GOVERNOR_DECISION_KIND,
  /** 直接进入 DSH 官方 Trajectory snapshot builder。 */
  target: GOVERNOR_DECISION_TARGET,
  /** 提取本 Definition 的业务身份：decisionId（幂等键，稳定且唯一）。 */
  match(event: { type: string; data: unknown; seq?: number }): {
    id: string;
    role: 'start';
  } | null {
    const decision = governorDecisionFromEvent(event as never);
    if (decision === undefined) return null;
    const data = decision as unknown as Record<string, unknown>;
    const decisionId = readString(data['decisionId']);
    // 旧 schema/损坏事件缺 decisionId：回退到事件 seq（会话内单调唯一），
    // 保证卡片仍可挂载（GOV-TRACE-002 AC 5：显示「未知」而非丢事件）。
    const id =
      decisionId !== null
        ? decisionId
        : typeof event.seq === 'number'
          ? `seq-${event.seq}`
          : 'unknown';
    return { id, role: 'start' };
  },
  /** 从 start Match 构建卡片状态（防御性解析，缺失字段 → unknown）。 */
  start(
    _context: ConversationNodeContext<GovernorDecisionCardState>,
    match: ConversationMatch,
  ): GovernorDecisionCardState {
    const event = match.event;
    const decision = governorDecisionFromEvent(event);
    if (decision === undefined) {
      throw new Error(`GOVERNOR_CARD_STATE: unexpected event type ${event.type}`);
    }
    return toCardState(decision);
  },
  /** 无更新事件：决策事件自包含，update 恒返回既有状态。 */
  update(
    context: ConversationNodeContext<GovernorDecisionCardState> & {
      readonly state: GovernorDecisionCardState;
    },
  ): GovernorDecisionCardState {
    return context.state;
  },
  /** 渲染实现：用官方 `kind: node` contribution 投影为 context notice。 */
  buildViewNode(
    context: ConversationNodeContext<GovernorDecisionCardState>,
  ): ConversationViewNode | null {
    const state = context.state;
    if (state === undefined) return null;
    const anchorSeq = context.start?.event.seq ?? 0;
    const eventTime = context.start?.event.time;
    const time =
      state.occurredAt ??
      (typeof eventTime === 'number' && Number.isFinite(eventTime) ? eventTime : 0);
    const source = { kind: 'plugin', plugin: 'dsh-llm-governor', form: 'notice' } as const;
    const viewNode: GovernorTrajectoryViewNode = {
      // The assembler owns identity (including the seq fallback for a damaged
      // legacy event) and rejects a node reconstructed from state identity.
      key: context.key,
      kind: context.kind,
      id: context.id,
      target: GOVERNOR_DECISION_TARGET,
      anchorSeq,
      location: context.start?.location ?? { kind: 'unresolved' },
      data: {
        kind: 'node',
        node: {
          kind: 'context',
          seq: anchorSeq,
          time,
          content: [{ type: 'text', text: decisionMarkdown(state) }],
          source,
          provenance: { role: 'inject', label: 'dsh-llm-governor' },
          form: 'notice',
        },
      },
    };
    return viewNode;
  },
};

// ===== Composer Auto selector（GOV-SELECT-001） =====

/**
 * Composer 模型选择座席的 Governor 注入面（浏览器组件消费）。
 *
 * 选择 Auto 调用与 `/model auto` 同一 Host 方法（AC 7）：持久化确认
 * （selection-mode 事件 durable ack）成功后才确认 UI；失败抛错由组件回滚，
 * 不允许抢跑请求（AC 1）。
 */
export interface GovernorModelSeatInjected {
  /** 该会话是否可用（subagent 受限等限制由浏览器侧判定后注入）。 */
  readonly available: boolean;
  /** 当前 selection mode。 */
  readonly selectionMode: 'auto' | 'manual';
  /** Manual 模式下最近一次手动选择（切回 Manual 的提示；无则要求重新选择）。 */
  readonly lastManualRoute: string | null;
  /** 选择「自动（Governor）」：调用 Host `setSessionSelectionMode(sessionId, 'auto')`。 */
  selectAuto(): Promise<{ mode: 'auto' | 'manual'; selectionRevision: number }>;
}

/**
 * 构建单占位 selector 的注入面（sessionId 级；官方 occupant 之外的
 * Governor 侧接线，spec 由 `governorModelSeatSpec` 携带）。
 */
export function governorModelSeatInject(
  service: GovernorService,
  sessionId: string,
  currentRoute?: string,
): GovernorModelSeatInjected {
  return {
    available: true,
    selectionMode: service.getSessionSelectionMode(sessionId).mode,
    lastManualRoute: service.getSessionSelectionMode(sessionId).lastManualRoute ?? null,
    selectAuto: () =>
      service.setSessionSelectionMode(
        sessionId,
        'auto',
        currentRoute !== undefined ? { currentRoute } : undefined,
      ),
  };
}

/**
 * 单占位 selector 注册 spec（`conversation.input.model` 座席）。
 *
 * 选项「自动（Governor）」置顶显示，不伪造成 Provider 模型；选择具体模型
 * 的路径（Manual + DSH 既有 model directory select）由浏览器组件保留；
 * 两种加载顺序、HMR 与卸载恢复见 browser-client UI 测试。
 */
export function governorModelSeatSpec(service: GovernorService): {
  name: string;
  label: string;
  inject: (sessionId: string) => GovernorModelSeatInjected;
} {
  return {
    name: GOVERNOR_MODEL_SEAT,
    /** 置顶选项文案（中英文由浏览器侧文案资源选择）。 */
    label: '自动（Governor）',
    inject: (sessionId: string) => governorModelSeatInject(service, sessionId),
  };
}

// ===== Settings 分区（GOV-UI-001） =====

/** Settings 分区声明：Routing/Models/Users 可回读 CRUD + Usage 只读（P0 范围）。 */
export const governorSettingsSection = {
  name: 'governor',
  title: 'Governor',
  /** Settings 子分区。 */
  sections: [
    { key: 'routing', title: '路由', readOnly: false },
    { key: 'models', title: '模型', readOnly: false },
    { key: 'users', title: '用户', readOnly: false },
    { key: 'usage', title: '用量', readOnly: true },
  ],
};
