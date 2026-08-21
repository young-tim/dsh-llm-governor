/**
 * Governor 自有 Session Event：类型合并、幂等 append 与会话控制状态重建。
 *
 * 本模块是 rc.8 Session Event 接缝的 Governor 侧封装：
 * - 通过 declaration merge 在 rc.8 已知、非 surface 的 `request/context`
 *   envelope 上增加 `governorDecision` / `governorSelection` 命名投影。
 *   `request/context` 只投影路由元数据，不参与 Prompt/消息重建；旧 rc.8
 *   reader 认识该 envelope 并保留额外 JSON 字段，因而卸载 Governor 后仍能冷恢复。
 * - 提供「扫描持久 log + append」的幂等 append：rc.8 的
 *   `Session.append(type, data)` 没有幂等键参数，同一 decisionId 的重试由
 *   Governor 扫描会话 log 去重。
 * - 提供从事件流重建 `governor.session.v1` 会话控制状态（selection mode）的
 *   纯函数，供 restore/fork 后恢复 Governor 选择模式。
 *
 * 早期开发版写过的 `governor/*` envelope 仅作读取兼容，不再新写。
 * 这避免了 rc.8 未知事件必须有 `ignorable: true` 但 append API 又无法写入
 * 该 envelope 字段的断层，也不需要修改 node_modules 或动态篡改已知类型集。
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { parseRoute } from '../model/canonical.js';

/** Governor Session Event 的 schema 版本（稳定码随版本演进，只增不改）。 */
export const GOVERNOR_SESSION_EVENT_SCHEMA_VERSION = 1;

/**
 * `governor/routing-decision` 事件数据：一次路由计算的唯一不可变决策投影。
 * 纯信息记录：不参与 Prompt 或会话消息重建（非 surface 事件）。
 */
export interface GovernorRoutingDecisionEventData {
  /** 事件 schema 版本。 */
  schemaVersion: number;
  /** 幂等键：`<requestId>:<fallbackIndex>`，双写两侧共用。 */
  decisionId: string;
  /** RFC 8785 JCS 规范化后 SHA-256 的小写十六进制摘要。 */
  decisionHash: string;
  /** 同一逻辑模型请求的标识；middleware 重入/Fallback/乱序回调复用。 */
  requestId: string;
  /** 事件归属的 turn/step 与本 attempt 的 fallback 序号。 */
  turn: number;
  step: number;
  fallbackIndex: number;
  /** 兼容字段：causes 的最高优先级投影。 */
  trigger: 'initial' | 'resume' | 'step' | 'selection_mode_change' | 'config_change' | 'fallback';
  /** 全部发生原因（如 resume + selection_mode_change 同时出现）。 */
  causes: readonly string[];
  /** 精确变化字段，仅允许固定枚举集合。 */
  changedFields: readonly string[];
  /** 用户选择模式。 */
  selectionMode: 'manual' | 'auto';
  /** 实际执行策略。 */
  effectiveStrategy: 'manual' | 'quality_first' | 'credit_first';
  /** 分类结果（Auto 时存在）。 */
  classification?: {
    taskType: string;
    complexity: string;
    confidence: number;
    source: 'hint' | 'rule' | 'llm';
  };
  /** 该 attempt 使用的最低质量门槛。 */
  minimumQuality?: number;
  /** 候选集摘要（受 64 项截断限制）。 */
  candidates?: ReadonlyArray<{ routeId: string; quality?: number; multiplierPpm: number }>;
  /** 排除集摘要（受 128 项截断限制）。 */
  excluded?: ReadonlyArray<{ routeId: string; reason: string }>;
  /** 路由计算结果；selected 不代表 Provider 已调用。 */
  outcome: 'selected' | 'rejected';
  /** 所选路由（`provider:model`；outcome=selected 时存在，Trajectory 卡片显示）。 */
  selectedRoute?: string;
  /** 决策使用的配置 revision。 */
  configRevision: number;
  /** 拒绝时的稳定错误码。 */
  errorCode?: string;
  /** 事件时间（毫秒）。 */
  occurredAt: number;
}

/**
 * `governor/selection-mode` 事件数据：用户切换 Auto/Manual 的会话控制状态变更。
 * 切换在 Host 持久化确认后生效并追加本事件（governor.session.v1 的 durable 投影）。
 */
export interface GovernorSelectionModeEventData {
  /** 事件 schema 版本。 */
  schemaVersion: number;
  /** 会话 selection 状态版本：每次成功切换递增，多标签页 expected-revision 冲突保护。 */
  selectionRevision: number;
  /** 切换后的模式。 */
  mode: 'auto' | 'manual';
  /** Manual 模式下最近一次手动选择；切回 Auto 时保留但不约束 Auto 结果。 */
  lastManualRoute?: string;
  /** 切换时已提交的最新决策配置 revision。 */
  lastDecisionConfigRevision?: number;
  /** 事件时间（毫秒）。 */
  changedAt: number;
}

/**
 * 在 rc.8 公开 RequestContext 扩展面上携带 Governor 的纯信息投影。
 *
 * 旧 `governor/*` 声明仅用于读取开发期内存 seed；新写入统一使用
 * `request/context` carrier，保证 rc.8 persistence 冷读与插件卸载兼容。
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface RequestContext {
    /** Governor 决策审计投影；纯信息，不参与 request reconstruction。 */
    governorDecision?: GovernorRoutingDecisionEventData;
    /** Governor 会话选择状态投影；纯信息。 */
    governorSelection?: GovernorSelectionModeEventData;
  }

  interface SessionEventMap {
    /** @deprecated 仅读取兼容；新写入使用 request/context.governorDecision。 */
    'governor/routing-decision': GovernorRoutingDecisionEventData;
    /** @deprecated 仅读取兼容；新写入使用 request/context.governorSelection。 */
    'governor/selection-mode': GovernorSelectionModeEventData;
  }
}

/** `request/context` carrier 必须携带的真实 DSH route。 */
export interface GovernorEventCarrierRoute {
  provider: string;
  model: string;
}

/** 从新 carrier 或旧 governor/* envelope 读取统一决策 payload。 */
export function governorDecisionFromEvent(
  event: SessionEvent,
): GovernorRoutingDecisionEventData | undefined {
  if (event.type === 'governor/routing-decision') return event.data;
  return event.type === 'request/context' ? event.data.governorDecision : undefined;
}

/** 从新 carrier 或旧 governor/* envelope 读取统一选择状态 payload。 */
export function governorSelectionFromEvent(
  event: SessionEvent,
): GovernorSelectionModeEventData | undefined {
  if (event.type === 'governor/selection-mode') return event.data;
  return event.type === 'request/context' ? event.data.governorSelection : undefined;
}

/** 从明确 route、当前 context 或 header 中解析 carrier route。 */
function resolveCarrierRoute(
  session: Session,
  preferred?: GovernorEventCarrierRoute,
): GovernorEventCarrierRoute {
  if (preferred !== undefined && preferred.provider.length > 0 && preferred.model.length > 0) {
    return preferred;
  }
  const context = session.requestContext();
  if (context !== undefined && context.provider.length > 0 && context.model.length > 0) {
    return { provider: context.provider, model: context.model };
  }
  const config = session.requestHeader()?.config;
  if (config !== undefined && config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model };
  }
  throw new Error('Governor request/context carrier requires a real provider/model route');
}

/** 仅在 route 未变时保留 DSH 已解析的 contextWindow。 */
function matchingContextWindow(
  session: Session,
  route: GovernorEventCarrierRoute,
): number | undefined {
  const context = session.requestContext();
  return context?.provider === route.provider && context.model === route.model
    ? context.contextWindow
    : undefined;
}

/**
 * 幂等追加一条携带 `governorDecision` 投影的 `request/context` 事件。
 *
 * 持久层幂等实现：append 前扫描 session log，若已存在相同 decisionId 的事件
 * 则直接返回该事件，不产生第二条逻辑记录；decisionId 不同但 hash 相同属于
 * 上游冲突语义（由调用方抛 DECISION_CONFLICT）。同一进程内同一 decisionId
 * 的写入路径是串行的，扫描-追加窗口不存在并发竞争。
 *
 * @param session - 目标会话。
 * @param data - 决策事件数据。
 * @returns 追加（或已存在）的事件。
 */
export function appendGovernorDecision(
  session: Session,
  data: GovernorRoutingDecisionEventData,
  carrierRoute?: GovernorEventCarrierRoute,
): SessionEvent<'request/context'> {
  const existing = findGovernorDecision(session, data.decisionId);
  if (existing !== undefined) {
    const existingData =
      existing.type === 'request/context' ? existing.data.governorDecision : existing.data;
    if (existingData.decisionHash !== data.decisionHash) {
      throw new Error(`DECISION_CONFLICT: ${data.decisionId}`);
    }
    if (existing.type === 'request/context') return existing;
    // 历史 governor/* seed 已有同 hash：不新增第二个逻辑事件。
    return existing as unknown as SessionEvent<'request/context'>;
  }
  const route = resolveCarrierRoute(
    session,
    carrierRoute ??
      (data.selectedRoute !== undefined
        ? parseRoute(data.selectedRoute)
        : data.candidates?.[0]?.routeId !== undefined
          ? parseRoute(data.candidates[0].routeId)
          : data.excluded?.[0]?.routeId !== undefined
            ? parseRoute(data.excluded[0].routeId)
            : undefined),
  );
  const contextWindow = matchingContextWindow(session, route);
  return session.append('request/context', {
    ...route,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    governorDecision: data,
  });
}

/**
 * 幂等追加一条携带 `governorSelection` 投影的 `request/context` 事件。
 *
 * 同一 selectionRevision 的重复提交（保存确认重试、乱序回调）不产生第二条
 * 记录；revision 更大时正常追加。revision 回退由调用方（Host 持久化层）用
 * expected-revision 检查拒绝，这里不做静默覆盖。
 *
 * @param session - 目标会话。
 * @param data - 选择模式事件数据。
 * @returns 追加（或已存在）的事件。
 */
export function appendGovernorSelectionMode(
  session: Session,
  data: GovernorSelectionModeEventData,
  carrierRoute?: GovernorEventCarrierRoute,
): SessionEvent<'request/context'> {
  const existing = findGovernorSelectionMode(session, data.selectionRevision);
  if (existing !== undefined) {
    if (existing.type === 'request/context') return existing;
    return existing as unknown as SessionEvent<'request/context'>;
  }
  const route = resolveCarrierRoute(
    session,
    carrierRoute ??
      (data.lastManualRoute !== undefined ? parseRoute(data.lastManualRoute) : undefined),
  );
  const contextWindow = matchingContextWindow(session, route);
  return session.append('request/context', {
    ...route,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    governorSelection: data,
  });
}

/**
 * 在 session log 中查找指定 decisionId 的 Governor 决策事件。
 *
 * @param session - 目标会话。
 * @param decisionId - 幂等键 `<requestId>:<fallbackIndex>`。
 * @returns 已存在的事件；不存在返回 undefined。
 */
export function findGovernorDecision(
  session: Session,
  decisionId: string,
):
  | SessionEvent<'governor/routing-decision'>
  | (SessionEvent<'request/context'> & {
      data: SessionEvent<'request/context'>['data'] & {
        governorDecision: GovernorRoutingDecisionEventData;
      };
    })
  | undefined {
  for (const event of session.events) {
    const data = governorDecisionFromEvent(event);
    if (data?.decisionId !== decisionId) continue;
    if (event.type === 'governor/routing-decision') return event;
    if (event.type === 'request/context') {
      return event as SessionEvent<'request/context'> & {
        data: SessionEvent<'request/context'>['data'] & {
          governorDecision: GovernorRoutingDecisionEventData;
        };
      };
    }
  }
  return undefined;
}

/**
 * 在 session log 中查找指定 selectionRevision 的选择模式事件。
 *
 * @param session - 目标会话。
 * @param selectionRevision - 会话 selection 状态版本。
 * @returns 已存在的事件；不存在返回 undefined。
 */
export function findGovernorSelectionMode(
  session: Session,
  selectionRevision: number,
):
  | SessionEvent<'governor/selection-mode'>
  | (SessionEvent<'request/context'> & {
      data: SessionEvent<'request/context'>['data'] & {
        governorSelection: GovernorSelectionModeEventData;
      };
    })
  | undefined {
  for (const event of session.events) {
    const data = governorSelectionFromEvent(event);
    if (data?.selectionRevision !== selectionRevision) continue;
    if (event.type === 'governor/selection-mode') return event;
    if (event.type === 'request/context') {
      return event as SessionEvent<'request/context'> & {
        data: SessionEvent<'request/context'>['data'] & {
          governorSelection: GovernorSelectionModeEventData;
        };
      };
    }
  }
  return undefined;
}

/** 从事件流重建的 `governor.session.v1` 会话控制状态。 */
export interface GovernorSessionSelectionState {
  /** 当前选择模式。 */
  mode: 'auto' | 'manual';
  /** 最近一次 Manual 选择（存在时便于切回；不约束 Auto 结果）。 */
  lastManualRoute?: string;
  /** 最新 selection 版本（expected-revision 冲突保护）。 */
  selectionRevision: number;
  /** 切换时已提交的最新决策配置 revision。 */
  lastDecisionConfigRevision?: number;
}

/**
 * 从 session 事件流重建 Governor 会话选择状态（restore/fork 后的恢复路径）。
 *
 * 旧会话没有 selection-mode 事件时返回 undefined（调用方按全局默认初始化并
 * 在首次写入时升级），不从 Decision Event 反推模式。
 *
 * @param events - 会话事件流（持久 seed 或 live log 均可）。
 * @returns 重建的状态；无任何 selection-mode 事件时返回 undefined。
 */
export function restoreGovernorSelection(
  events: readonly SessionEvent[],
): GovernorSessionSelectionState | undefined {
  let state: GovernorSessionSelectionState | undefined;
  for (const event of events) {
    const data = governorSelectionFromEvent(event);
    if (data === undefined) continue;
    state = {
      mode: data.mode,
      selectionRevision: data.selectionRevision,
      ...(data.lastManualRoute !== undefined ? { lastManualRoute: data.lastManualRoute } : {}),
      ...(data.lastDecisionConfigRevision !== undefined
        ? { lastDecisionConfigRevision: data.lastDecisionConfigRevision }
        : {}),
    };
  }
  return state;
}
