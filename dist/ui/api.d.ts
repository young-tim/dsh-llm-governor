/**
 * Governor HTTP API 请求处理器（GOV-SEC-001 安全收敛版）。
 *
 * - 方法级 capability 矩阵：governor.read / governor.manage / governor.audit，
 *   Host 端逐方法复核，不依赖菜单或按钮隐藏。
 * - 认证：Bearer token（Authorization: Bearer <token>），不使用 Cookie；
 *   未认证访问受保护资源返回 UNAUTHORIZED，权限不足返回 FORBIDDEN。
 * - CORS：默认不返回 CORS 头（同源语义）；显式配置 allowedOrigin 时只返回
 *   该 origin，绝不返回通配 `*`。
 * - 请求体上限 256 KiB；列表分页遵循 50/200 与 31 天窗口（service 层保证）。
 * - 错误响应只包含 code、requestId 与安全摘要，不泄露 SQL/路径/正文。
 *
 * 挂载方式：
 * 1. createGovernorApiServer：兼容 API 独立服务器（仅显式 compatApi.enabled
 *    时监听 loopback；handler 强制校验 loopback peer）。
 * 2. DSH webServer 前缀路由：/governor 注册到 ctx.webServer（受信 Host 面）。
 */
import http from 'node:http';
import type { GovernorService } from '../plugin/service.js';
import type { GovernorCapability } from '../security/governor-capabilities.js';
/** 请求体上限（字节）：Remote/兼容 API 256 KiB（优化文档 7.1）。 */
export declare const MAX_REQUEST_BODY_BYTES: number;
export type { GovernorCapability } from '../security/governor-capabilities.js';
/** 已认证主体。 */
export interface GovernorActor {
    /** 主体标识（token 的稳定摘要，不回传 token 本身）。 */
    id: string;
    /** 主体能力集合。 */
    capabilities: ReadonlySet<GovernorCapability>;
}
/** 兼容 API / 受信通道的主体配置。 */
export interface GovernorActorConfig {
    /** Bearer token（至少 256 bit 随机值，由部署方生成）。 */
    token: string;
    /** 该主体被授予的能力。 */
    capabilities: GovernorCapability[];
}
/** API 服务器选项。 */
export interface GovernorApiServerOptions {
    /** 主体列表（Bearer token → capability 映射）。 */
    actors?: GovernorActorConfig[];
    /** 显式允许的 CORS origin（如 DSH Web 的 https://host:port）；缺省不发 CORS 头。 */
    allowedOrigin?: string;
    /** 强制 loopback peer（兼容 API 独立监听时必须为 true）。 */
    requireLoopback?: boolean;
    /** 兼容旧配置的管理员令牌（映射为全能力主体；已废弃，仅为迁移保留）。 */
    adminToken?: string;
}
/**
 * 生成至少 256 bit 的随机 Bearer token（部署方未提供时使用）。
 *
 * @returns 64 个十六进制字符（256 bit）的随机 token。
 */
export declare function generateCompatToken(): string;
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
 * @param opts - 认证主体与 CORS 配置。
 * @returns 处理器函数；basePath 是挂载前缀（如 '/governor'），会先从路径中剥离。
 */
export declare function createGovernorRequestHandler(governor: GovernorService, opts?: GovernorApiServerOptions): (req: http.IncomingMessage, res: http.ServerResponse, basePath?: string) => Promise<void>;
/**
 * 创建兼容 API 独立服务器（仅显式 compatApi.enabled 时使用；强制 loopback）。
 *
 * @param governor - GovernorService 实例。
 * @param opts - 认证主体与 CORS 配置（requireLoopback 强制为 true）。
 * @returns http.Server 实例，调用方负责 listen（127.0.0.1 或 [::1]）和 close。
 */
export declare function createGovernorApiServer(governor: GovernorService, opts?: GovernorApiServerOptions): http.Server;
