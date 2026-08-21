/** Trajectory 卡片 Definition 的唯一 kind（会话引擎内的 Context 类别）。 */
const GOVERNOR_DECISION_KIND = 'governor-routing-decision';
/** 卡片视图的唯一 target（视图构建器注册名）。 */
const GOVERNOR_DECISION_TARGET = 'governor-decision';
/** Composer 单占位模型选择座席（ui-conversation SlotMap 声明，官方 occupant 之外）。 */
const GOVERNOR_MODEL_SEAT = 'conversation.input.model';
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
};
/** 防御性字符串读取（旧 schema/缺失字段 → null，对应 UI 显示「未知」）。 */
function readString(value) {
    return typeof value === 'string' ? value : null;
}
/** 防御性数字读取（非有限数字 → null）。 */
function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/** 防御性只读数组读取（非数组 → 空数组）。 */
function readArray(value) {
    return Array.isArray(value) ? value : [];
}
/**
 * 事件数据 → 卡片状态（GOV-TRACE-002 AC 5：字段缺失或旧 schema 时取
 * `unknown`/`null`，不伪造值、不抛错破坏卡片挂载）。
 */
function toCardState(data) {
    // 以 unknown 视角防御性读取：事件可能来自旧 schema 或被截断的持久化副本。
    const raw = data;
    const candidates = readArray(raw['candidates']).map((item) => {
        const c = (item ?? {});
        return {
            routeId: readString(c['routeId']) ?? 'unknown',
            quality: readNumber(c['quality']),
            multiplierPpm: readNumber(c['multiplierPpm']),
        };
    });
    const excluded = readArray(raw['excluded']).map((item) => {
        const e = (item ?? {});
        return {
            routeId: readString(e['routeId']) ?? 'unknown',
            reason: readString(e['reason']) ?? 'unknown',
        };
    });
    const classificationRaw = raw['classification'];
    const classification = classificationRaw !== null && typeof classificationRaw === 'object'
        ? (() => {
            const c = classificationRaw;
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
        selectionMode: selectionMode === 'auto' || selectionMode === 'manual' ? selectionMode : 'unknown',
        effectiveStrategy: effectiveStrategy === 'manual' ||
            effectiveStrategy === 'quality_first' ||
            effectiveStrategy === 'credit_first'
            ? effectiveStrategy
            : 'unknown',
        outcome: outcome === 'selected' || outcome === 'rejected' ? outcome : 'unknown',
        errorCode: readString(raw['errorCode']),
        trigger: readString(raw['trigger']),
        causes: readArray(raw['causes']).filter((c) => typeof c === 'string'),
        changedFields: readArray(raw['changedFields']).filter((f) => typeof f === 'string'),
        classification,
        minimumQuality: readNumber(raw['minimumQuality']),
        selectedRoute: readString(raw['selectedRoute']),
        candidates,
        excluded,
        configRevision: readNumber(raw['configRevision']),
    };
}
/** 从候选列表读取所选路由的倍率与质量（selected 时候选首位即所选）。 */
function selectedRouteMetrics(state) {
    if (state.selectedRoute === null)
        return { multiplierPpm: null, quality: null };
    const top = state.candidates[0];
    if (top === undefined || top.routeId !== state.selectedRoute) {
        return { multiplierPpm: null, quality: null };
    }
    return { multiplierPpm: top.multiplierPpm, quality: top.quality };
}
/** 构建选择变化或拒绝的原因摘要（trigger 优先，rejected 附带错误码）。 */
function buildReason(state) {
    const parts = [];
    if (state.trigger !== null)
        parts.push(state.trigger);
    for (const cause of state.causes) {
        if (cause !== state.trigger)
            parts.push(cause);
    }
    if (state.outcome === 'rejected' && state.errorCode !== null) {
        parts.push(state.errorCode);
    }
    return parts.length > 0 ? parts.join(', ') : null;
}
/** 卡片状态 → 视图数据（摘要 + 抽屉）。 */
function buildCardViewData(state) {
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
export const governorTrajectoryDefinition = {
    kind: GOVERNOR_DECISION_KIND,
    /** 卡片视图 target：由 `governorDecisionViewDefinition` 的构建器消费。 */
    target: GOVERNOR_DECISION_TARGET,
    /** 提取本 Definition 的业务身份：decisionId（幂等键，稳定且唯一）。 */
    match(event) {
        if (event.type !== 'governor/routing-decision')
            return null;
        const data = event.data;
        const decisionId = readString(data['decisionId']);
        // 旧 schema/损坏事件缺 decisionId：回退到事件 seq（会话内单调唯一），
        // 保证卡片仍可挂载（GOV-TRACE-002 AC 5：显示「未知」而非丢事件）。
        const id = decisionId !== null
            ? decisionId
            : typeof event.seq === 'number'
                ? `seq-${event.seq}`
                : 'unknown';
        return { id, role: 'start' };
    },
    /** 从 start Match 构建卡片状态（防御性解析，缺失字段 → unknown）。 */
    start(_context, match) {
        const event = match.event;
        if (event.type !== 'governor/routing-decision') {
            throw new Error(`GOVERNOR_CARD_STATE: unexpected event type ${event.type}`);
        }
        return toCardState(event.data);
    },
    /** 无更新事件：决策事件自包含，update 恒返回既有状态。 */
    update(context) {
        return context.state;
    },
    /** 渲染实现：产出卡片视图节点（摘要 + 抽屉数据）。 */
    buildViewNode(context) {
        const state = context.state;
        if (state === undefined)
            return null;
        return {
            key: `${GOVERNOR_DECISION_KIND}:${state.decisionId}`,
            kind: GOVERNOR_DECISION_KIND,
            id: state.decisionId,
            target: GOVERNOR_DECISION_TARGET,
            data: buildCardViewData(state),
        };
    },
};
/**
 * `governor-decision` 视图构建器注册：为每个 Session 创建增量构建器
 * （`replace` 全量替换、`apply` 按 key 合并变更节点）。
 */
export const governorDecisionViewDefinition = {
    target: GOVERNOR_DECISION_TARGET,
    create() {
        let snapshot = { nodes: [], turnOrder: [] };
        return {
            empty: snapshot,
            replace(input) {
                snapshot = { nodes: [...input.nodes], turnOrder: [...input.timeline.turnOrder] };
                return snapshot;
            },
            apply(input) {
                const merged = new Map(snapshot.nodes.map((node) => [node.key, node]));
                for (const node of input.upserts)
                    merged.set(node.key, node);
                snapshot = { nodes: [...merged.values()], turnOrder: [...input.timeline.turnOrder] };
                return snapshot;
            },
        };
    },
};
/**
 * 构建单占位 selector 的注入面（sessionId 级；官方 occupant 之外的
 * Governor 侧接线，spec 由 `governorModelSeatSpec` 携带）。
 */
export function governorModelSeatInject(service, sessionId) {
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
export function governorModelSeatSpec(service) {
    return {
        name: GOVERNOR_MODEL_SEAT,
        /** 置顶选项文案（中英文由浏览器侧文案资源选择）。 */
        label: '自动（Governor）',
        inject: (sessionId) => governorModelSeatInject(service, sessionId),
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
/**
 * 从 Cordis 上下文安全读取 client 注册面。
 *
 * Cordis Context 是 Proxy：未声明 inject 直接读属性会抛
 * `cannot get property ... without inject`，因此统一经 `ctx.get(name)`
 * 可选服务面读取（与 mod.ts 访问 webServer/sessions 同一模式）；
 * 非 Cordis 上下文（无 get 方法）或服务未提供时返回 undefined。
 */
function lookupRegistries(ctx) {
    const get = ctx?.get;
    if (typeof get !== 'function')
        return {};
    const read = (name) => {
        try {
            return get(name);
        }
        catch {
            // 上下文未提供该服务（如 Host/Node 环境）：安全跳过。
            return undefined;
        }
    };
    const registries = {
        conversationEvents: read('conversationEvents'),
        conversationViews: read('conversationViews'),
        slots: read('slots'),
        settings: read('settings'),
    };
    return registries;
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
export function registerClientSurface(ctx, options) {
    const disposers = [];
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
    if (client?.slots?.register !== undefined &&
        options?.service !== undefined &&
        options.selectorComponent !== undefined) {
        const dispose = client.slots.register(governorModelSeatSpec(options.service), options.selectorComponent);
        disposers.push(dispose);
    }
    // Settings 分区注册。
    if (client?.settings?.section !== undefined) {
        const dispose = client.settings.section(governorSettingsSection);
        disposers.push(dispose);
    }
    return disposers;
}
