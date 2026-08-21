/**
 * DSH Client 侧原生注册：Trajectory 决策卡片、Composer Auto selector、Settings 分区。
 *
 * SEAM-5（docs/UPSTREAM_SEAMS.md）：dsh-client-runtime 的 client 入口是浏览器
 * bundle（`window.__ModuleLoader__.load(...)`），Node 无法实例化。本模块交付两层：
 *
 * 1. 契约完整的注册对象（类型直接取自 `@deepseek-ai/dsh-client-runtime/client`
 *    的公开契约，tsc 编译期校验）：
 *    - `governorTrajectoryDefinition`：Trajectory 卡片的完整
 *      `ConversationNodeDefinition` 实现——含 `buildViewNode` 渲染实现
 *      （GOV-TRACE-002 卡片摘要 + 详情抽屉视图模型）；
 *    - `governorDecisionViewDefinition`：`governor-decision` target 的
 *      `ConversationViewDefinition`（per-session 增量视图构建器）；
 *    - `governorModelSeatSpec` / `governorModelSeatInject`：Composer 单占位
 *      模型选择座席（`conversation.input.model`）的注册 spec 与注入面——
 *      选择 Auto 调用与 `/model auto` 同一 Host 方法（GOV-SELECT-001 AC 7）；
 *    - `governorSettingsSection`：Settings 分区声明（GOV-UI-001）。
 *
 * 2. `registerClientSurface(ctx, options)` 接线函数：浏览器 client 上下文
 *    （`ctx.conversationEvents` / `ctx.conversationViews` / `ctx.slots` /
 *    settings 面可用时）执行注册并返回 disposer 列表；Host/Node 环境安全
 *    跳过（SEAM-5，合同测试以发布物取证）。React 组件与运行时挂载验证
 *    随 B-3 的浏览器 E2E harness 交付（BLOCKED.md）。
 */
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationTimelineSnapshot,
  ConversationViewBuilder,
  ConversationViewDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client';
import type { GovernorRoutingDecisionEventData } from '../dsh-adapter/session-events.js';
import type { GovernorService } from './service.js';

/** Trajectory 卡片 Definition 的唯一 kind（会话引擎内的 Context 类别）。 */
const GOVERNOR_DECISION_KIND = 'governor-routing-decision';

/** 卡片视图的唯一 target（视图构建器注册名）。 */
const GOVERNOR_DECISION_TARGET = 'governor-decision';

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

/**
 * Governor 轨迹卡片 Definition：匹配 `governor/routing-decision` 事件，
 * 为每个 decisionId 建立独立 Context，`buildViewNode` 产出卡片视图节点。
 *
 * 事件是纯信息记录且自包含（无 update 事件）：`update` 恒返回既有状态；
 * 相同 route 的重复决策拥有不同 decisionId，各自成卡（折叠是渲染层行为）。
 */
export const governorTrajectoryDefinition: ConversationNodeDefinition<GovernorDecisionCardState> = {
  kind: GOVERNOR_DECISION_KIND,
  /** 卡片视图 target：由 `governorDecisionViewDefinition` 的构建器消费。 */
  target: GOVERNOR_DECISION_TARGET,
  /** 提取本 Definition 的业务身份：decisionId（幂等键，稳定且唯一）。 */
  match(event: { type: string; data: unknown; seq?: number }): {
    id: string;
    role: 'start';
  } | null {
    if (event.type !== 'governor/routing-decision') return null;
    const data = event.data as Record<string, unknown>;
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
    const event = match.event as { type: string; data: unknown };
    if (event.type !== 'governor/routing-decision') {
      throw new Error(`GOVERNOR_CARD_STATE: unexpected event type ${event.type}`);
    }
    return toCardState(event.data as GovernorRoutingDecisionEventData);
  },
  /** 无更新事件：决策事件自包含，update 恒返回既有状态。 */
  update(
    context: ConversationNodeContext<GovernorDecisionCardState> & {
      readonly state: GovernorDecisionCardState;
    },
  ): GovernorDecisionCardState {
    return context.state;
  },
  /** 渲染实现：产出卡片视图节点（摘要 + 抽屉数据）。 */
  buildViewNode(
    context: ConversationNodeContext<GovernorDecisionCardState>,
  ): ConversationViewNode | null {
    const state = context.state;
    if (state === undefined) return null;
    return {
      key: `${GOVERNOR_DECISION_KIND}:${state.decisionId}`,
      kind: GOVERNOR_DECISION_KIND,
      id: state.decisionId,
      target: GOVERNOR_DECISION_TARGET,
      data: buildCardViewData(state),
    };
  },
};

// ===== 视图构建器（governor-decision target 的 per-session 快照） =====

/** Governor 决策卡片视图快照：当前卡片节点集 + turn 顺序。 */
export interface GovernorDecisionViewSnapshot {
  readonly nodes: readonly ConversationViewNode[];
  readonly turnOrder: readonly number[];
}

/**
 * `governor-decision` 视图构建器注册：为每个 Session 创建增量构建器
 * （`replace` 全量替换、`apply` 按 key 合并变更节点）。
 */
export const governorDecisionViewDefinition: ConversationViewDefinition<
  ConversationViewNode,
  GovernorDecisionViewSnapshot
> = {
  target: GOVERNOR_DECISION_TARGET,
  create(): ConversationViewBuilder<ConversationViewNode, GovernorDecisionViewSnapshot> {
    let snapshot: GovernorDecisionViewSnapshot = { nodes: [], turnOrder: [] };
    return {
      empty: snapshot,
      replace(input: {
        readonly nodes: readonly ConversationViewNode[];
        readonly timeline: ConversationTimelineSnapshot;
      }): GovernorDecisionViewSnapshot {
        snapshot = { nodes: [...input.nodes], turnOrder: [...input.timeline.turnOrder] };
        return snapshot;
      },
      apply(input: {
        readonly upserts: readonly ConversationViewNode[];
        readonly timeline: ConversationTimelineSnapshot;
      }): GovernorDecisionViewSnapshot {
        const merged = new Map(snapshot.nodes.map((node) => [node.key, node] as const));
        for (const node of input.upserts) merged.set(node.key, node);
        snapshot = { nodes: [...merged.values()], turnOrder: [...input.timeline.turnOrder] };
        return snapshot;
      },
    };
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
): GovernorModelSeatInjected {
  return {
    available: true,
    selectionMode: service.getSessionSelectionMode(sessionId).mode,
    lastManualRoute: service.getSessionSelectionMode(sessionId).lastManualRoute ?? null,
    selectAuto: () => service.setSessionSelectionMode(sessionId, 'auto'),
  };
}

/**
 * 单占位 selector 注册 spec（`conversation.input.model` 座席）。
 *
 * 选项「自动（Governor）」置顶显示，不伪造成 Provider 模型；选择具体模型
 * 的路径（Manual + DSH 既有 `session.selectModel`）由浏览器组件复刻
 * （GOV-SELECT-001 AC 11 的完整合同随 B-3 浏览器 E2E 交付）。
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

// ===== 接线 =====

/** 浏览器 client 上下文上的注册面（经 `ctx.get(name)` 可选读取；Node/Host 不存在）。 */
interface ClientRegistries {
  conversationEvents?:
    | {
        registerFallback(definition: unknown): () => void;
      }
    | undefined;
  conversationViews?:
    | {
        register(definition: unknown): () => void;
      }
    | undefined;
  slots?:
    | {
        register(spec: unknown, component: unknown): () => void;
      }
    | undefined;
  settings?:
    | {
        section(section: unknown): () => void;
      }
    | undefined;
}

/**
 * 从 Cordis 上下文安全读取 client 注册面。
 *
 * Cordis Context 是 Proxy：未声明 inject 直接读属性会抛
 * `cannot get property ... without inject`，因此统一经 `ctx.get(name)`
 * 可选服务面读取（与 mod.ts 访问 webServer/sessions 同一模式）；
 * 非 Cordis 上下文（无 get 方法）或服务未提供时返回 undefined。
 */
function lookupRegistries(ctx: unknown): ClientRegistries {
  const get = (ctx as { get?: (name: string) => unknown } | undefined)?.get;
  if (typeof get !== 'function') return {};
  const read = (name: string): unknown => {
    try {
      return get(name);
    } catch {
      // 上下文未提供该服务（如 Host/Node 环境）：安全跳过。
      return undefined;
    }
  };
  const registries: ClientRegistries = {
    conversationEvents: read('conversationEvents') as ClientRegistries['conversationEvents'],
    conversationViews: read('conversationViews') as ClientRegistries['conversationViews'],
    slots: read('slots') as ClientRegistries['slots'],
    settings: read('settings') as ClientRegistries['settings'],
  };
  return registries;
}

/** registerClientSurface 的可选参数。 */
export interface RegisterClientSurfaceOptions {
  /** Host 方法面（Auto selector 调用 setSessionSelectionMode 等）。 */
  service?: GovernorService;
  /**
   * Auto selector 的浏览器组件（B-3：React 组件随浏览器 E2E harness 交付；
   * 缺省时不注册 selector——不注册假组件，不抢占官方 occupant）。
   */
  selectorComponent?: unknown;
}

/**
 * 注册 Governor Client 侧原生体验（Trajectory / Auto selector / Settings）。
 *
 * 浏览器环境（注册面可用）执行注册并返回 disposer 列表；Node/Host 环境
 * （SEAM-5）安全跳过，返回空数组。调用方（mod.ts apply）在 ctx.effect 中
 * 注册 disposer，确保 HMR/卸载时清理（GOV-UI-001 AC 7）。
 *
 * @param ctx - Cordis 上下文（浏览器 client 上下文时注册面可用）。
 * @param options - service 与浏览器组件注入。
 * @returns disposer 函数列表（卸载时调用）。
 */
export function registerClientSurface(
  ctx: unknown,
  options?: RegisterClientSurfaceOptions,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  const client = lookupRegistries(ctx);

  // Trajectory 卡片注册（fallback：不抢占官方节点，作为补充视图）。
  if (client?.conversationEvents?.registerFallback !== undefined) {
    const dispose = client.conversationEvents.registerFallback(governorTrajectoryDefinition);
    disposers.push(dispose);
  }

  // 视图注册：governor-decision target 的 per-session 构建器。
  if (client?.conversationViews?.register !== undefined) {
    const dispose = client.conversationViews.register(governorDecisionViewDefinition);
    disposers.push(dispose);
  }

  // Composer Auto selector 注册：需要 slots 注册面 + Host service + 浏览器组件
  // （三者齐备才注册；组件缺失时不以假组件抢占官方 occupant——B-3）。
  if (
    client?.slots?.register !== undefined &&
    options?.service !== undefined &&
    options.selectorComponent !== undefined
  ) {
    const dispose = client.slots.register(
      governorModelSeatSpec(options.service),
      options.selectorComponent,
    );
    disposers.push(dispose);
  }

  // Settings 分区注册。
  if (client?.settings?.section !== undefined) {
    const dispose = client.settings.section(governorSettingsSection);
    disposers.push(dispose);
  }

  return disposers;
}
