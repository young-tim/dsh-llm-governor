/**
 * UI 模块入口：导出 HTTP API 请求处理器与独立服务器工厂。
 *
 * 领域模块保持独立可测；本模块仅负责将 GovernorService 方法暴露为
 * JSON 端点和静态 HTML 页面。运行时优先把处理器挂载到 DSH webServer 的
 * /governor 前缀路由；无 webServer 的环境（测试/headless）可用独立服务器。
 */
export { createGovernorApiServer, createGovernorRequestHandler, isLocalRequest } from './api.js';
export type { GovernorApiServerOptions } from './api.js';
