/**
 * UI 模块入口：导出 HTTP API 服务器工厂。
 *
 * 领域模块保持独立可测；本模块仅负责将 GovernorService 方法暴露为
 * JSON 端点和静态 HTML 页面。
 */
export { createGovernorApiServer } from './api.js';
export type { GovernorApiServerOptions } from './api.js';
