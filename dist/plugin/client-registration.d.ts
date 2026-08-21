/**
 * Shared browser contracts for the Governor trajectory, Composer selector and
 * Settings surfaces.  `src/client/index.ts` consumes these definitions from a
 * real rc.8 `dsh.client` bundle; the host client-module registry discovers that
 * bundle from the live Loader package entry and owns its HMR lifecycle.
 */
import type { ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client';
import type { GovernorService } from './service.js';
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
    readonly excluded: ReadonlyArray<{
        readonly routeId: string;
        readonly reason: string;
    }>;
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
export declare const GOVERNOR_CARD_LABELS: {
    readonly zh: {
        readonly selectionMode: {
            readonly auto: "自动选择";
            readonly manual: "手动选择";
            readonly unknown: "未知";
        };
        readonly strategy: {
            readonly manual: "手动";
            readonly quality_first: "质量优先";
            readonly credit_first: "额度优先";
            readonly unknown: "未知";
        };
        readonly outcome: {
            readonly selected: "已选择";
            readonly rejected: "已拒绝";
            readonly unknown: "未知";
        };
    };
    readonly en: {
        readonly selectionMode: {
            readonly auto: "Auto";
            readonly manual: "Manual";
            readonly unknown: "Unknown";
        };
        readonly strategy: {
            readonly manual: "Manual";
            readonly quality_first: "Quality First";
            readonly credit_first: "Credit First";
            readonly unknown: "Unknown";
        };
        readonly outcome: {
            readonly selected: "Selected";
            readonly rejected: "Rejected";
            readonly unknown: "Unknown";
        };
    };
};
/**
 * Governor 轨迹卡片 Definition：匹配 rc.8 兼容的
 * `request/context.data.governorDecision`，并保留旧 `governor/routing-decision`
 * 的只读兼容，
 * 为每个 decisionId 建立独立 Context，`buildViewNode` 产出卡片视图节点。
 *
 * 事件是纯信息记录且自包含（无 update 事件）：`update` 恒返回既有状态；
 * 相同 route 的重复决策拥有不同 decisionId，各自成卡（折叠是渲染层行为）。
 */
export declare const governorTrajectoryDefinition: ConversationNodeDefinition<GovernorDecisionCardState>;
/** Governor 决策卡片视图快照：当前卡片节点集 + turn 顺序。 */
export interface GovernorDecisionViewSnapshot {
    readonly nodes: readonly ConversationViewNode[];
    readonly turnOrder: readonly number[];
}
/**
 * `governor-decision` 视图构建器注册：为每个 Session 创建增量构建器
 * （`replace` 全量替换、`apply` 按 key 合并变更节点）。
 */
export declare const governorDecisionViewDefinition: ConversationViewDefinition<ConversationViewNode, GovernorDecisionViewSnapshot>;
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
    selectAuto(): Promise<{
        mode: 'auto' | 'manual';
        selectionRevision: number;
    }>;
}
/**
 * 构建单占位 selector 的注入面（sessionId 级；官方 occupant 之外的
 * Governor 侧接线，spec 由 `governorModelSeatSpec` 携带）。
 */
export declare function governorModelSeatInject(service: GovernorService, sessionId: string, currentRoute?: string): GovernorModelSeatInjected;
/**
 * 单占位 selector 注册 spec（`conversation.input.model` 座席）。
 *
 * 选项「自动（Governor）」置顶显示，不伪造成 Provider 模型；选择具体模型
 * 的路径（Manual + DSH 既有 model directory select）由浏览器组件保留；
 * 两种加载顺序、HMR 与卸载恢复见 browser-client UI 测试。
 */
export declare function governorModelSeatSpec(service: GovernorService): {
    name: string;
    label: string;
    inject: (sessionId: string) => GovernorModelSeatInjected;
};
/** Settings 分区声明：Routing/Models/Users 可回读 CRUD + Usage 只读（P0 范围）。 */
export declare const governorSettingsSection: {
    name: string;
    title: string;
    /** Settings 子分区。 */
    sections: {
        key: string;
        title: string;
        readOnly: boolean;
    }[];
};
