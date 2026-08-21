import type { Context } from '../dsh-adapter/mod.js';
import { GovernorService } from './service.js';
import type { GovernorPluginConfig } from './service.js';
export type { TaskClassifier, RoutingStrategy, RoutingContext, ModelQualityProvider, } from '../extensions/registry.js';
export { GovernorExtensionRegistry } from '../extensions/registry.js';
export type { IdentityProvider } from '../identity/types.js';
/**
 * Governor Cordis 插件入口。
 *
 * - inject llm：模型目录刷新与 LLM 分类器依赖 ctx.llm。
 * - 严格配置校验：apply() 第一行调用 resolveConfig()（fail closed：
 *   未知字段/范围越界/条件必填缺失直接抛错，Cordis 拒绝加载插件）。
 * - 创建 SQLite 仓库（默认 $DSH_HOME/dsh-llm-governor/governor.db，迁移失败 fail closed）。
 * - header/jwt 模式构建 IdentityProvider 实例并暴露 /governor/api/bind 入站绑定端点。
 * - 注册 agent/pre-step、agent/request、llm/stream、agent/request-error 监听器。
 * - UI 挂载：有 ctx.webServer 时注册 /governor 兼容前缀；独立监听仅在显式启用
 *   compatApi 时启动，默认不新增 socket。
 */
/**
 * 事件接线：把 Governor service 挂到 DSH 事件瀑布（pre-step/request/stream/
 * request-error/session 生命周期），并执行启动对账。
 *
 * 从 apply 提取为独立导出函数：测试可以自组环境（LlmRuntime + FakeAdapter +
 * SessionStore + 自定义 repository/sink 注入故障）后复用同一接线合同。
 *
 * @param ctx - Cordis 上下文。
 * @param service - 已构造的 Governor 服务实例。
 */
export declare function wireGovernorEvents(ctx: Context, service: GovernorService): Promise<void>;
export declare const GovernorPlugin: {
    name: string;
    inject: string[];
    apply(ctx: Context, config: GovernorPluginConfig): Promise<void>;
};
export default GovernorPlugin;
export type { GovernorPluginConfig };
