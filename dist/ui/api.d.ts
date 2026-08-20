/**
 * Governor HTTP API 请求处理器。
 *
 * 使用 Node 内置 http 模块，将 GovernorService 的方法包装为 JSON 端点。
 * 管理员写权限通过 X-Governor-Admin header 检查；普通用户只能执行读操作
 * （GET），写操作（PATCH）需要管理员权限。
 *
 * 该处理器有两种挂载方式：
 * 1. createGovernorApiServer：独立 http 服务器（测试与无 webServer 场景）。
 * 2. DSH webServer 前缀路由：插件运行时把 /governor 前缀注册到 ctx.webServer，
 *    浏览器通过 DSH Web 端口访问 /governor/pages/* 与 /governor/api/*。
 */
import http from 'node:http';
import type { GovernorService } from '../plugin/service.js';
/** API 服务器选项。 */
export interface GovernorApiServerOptions {
    /** 管理员令牌；客户端通过 X-Governor-Admin header 传入以获得写权限。 */
    adminToken?: string;
}
/**
 * 判断请求是否来自本地回环地址。
 * @param req - HTTP 请求对象。
 * @returns 是否为本地请求。
 */
declare function isLocalRequest(req: http.IncomingMessage): boolean;
export { isLocalRequest };
/**
 * 创建 Governor 请求处理器。
 *
 * @param governor - GovernorService 实例，端点将调用其方法。
 * @param opts - 可选配置，如管理员令牌。
 * @returns 处理器函数；basePath 是挂载前缀（如 '/governor'），会先从路径中剥离。
 */
export declare function createGovernorRequestHandler(governor: GovernorService, opts?: GovernorApiServerOptions): (req: http.IncomingMessage, res: http.ServerResponse, basePath?: string) => Promise<void>;
/**
 * 创建 Governor HTTP API 服务器（独立监听）。
 *
 * @param governor - GovernorService 实例，端点将调用其方法。
 * @param opts - 可选配置，如管理员令牌。
 * @returns http.Server 实例，调用方负责 listen 和 close。
 */
export declare function createGovernorApiServer(governor: GovernorService, opts?: GovernorApiServerOptions): http.Server;
