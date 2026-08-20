/**
 * 四种 IdentityProvider 实现：local、header、jwt、custom。
 *
 * 领域层，不导入任何 DSH 包。JWT 验证使用 Node crypto 模块。
 * 安全约束：
 * - JWT 禁止 alg=none，禁止只 decode 不 verify
 * - Header 模式必须配置可信代理来源
 * - 无身份或身份无效时 fail closed（抛 IdentityError）
 */
import { type JsonWebKey, KeyObject } from 'node:crypto';
import type { GovernorIdentity, IdentityContext, IdentityProvider } from './types.js';
/** LocalIdentityProvider 配置。 */
export interface LocalIdentityProviderConfig {
    /** 固定 user_id，默认 'local'。 */
    userId?: string;
    /** 展示名。 */
    displayName?: string;
    /** 邮箱。 */
    email?: string;
}
/**
 * LocalIdentityProvider：返回配置的固定 user_id，默认 'local'。
 * 适用于单用户或本地开发场景。
 */
export declare class LocalIdentityProvider implements IdentityProvider {
    readonly kind = "local";
    private readonly _identity;
    constructor(config?: LocalIdentityProviderConfig);
    /** 返回配置的固定身份。 */
    resolve(_context: IdentityContext): Promise<GovernorIdentity>;
}
/** HeaderIdentityProvider 配置。 */
export interface HeaderIdentityProviderConfig {
    /** 读取 user_id 的 Header 名（查找时不区分大小写）。必填。 */
    headerName: string;
    /** 可信代理来源标识，必填。强制声明信任边界。 */
    trustedProxy: string;
    /** 代理标识 Header 名，可选。配置后验证该 Header 值等于 trustedProxy。 */
    proxyHeaderName?: string;
    /** 读取展示名的 Header 名，可选。 */
    displayNameHeader?: string;
    /** 读取邮箱的 Header 名，可选。 */
    emailHeader?: string;
}
/**
 * HeaderIdentityProvider：从 Header 读取 user_id。
 * 由 Web 入站 adapter 在可信反向代理之后读取 Header，并在 Agent 首次使用前绑定 session。
 * 必须配置可信代理来源；代理必须覆盖并删除客户端伪造 Header。
 */
export declare class HeaderIdentityProvider implements IdentityProvider {
    readonly kind = "header";
    private readonly _headerName;
    private readonly _trustedProxy;
    private readonly _proxyHeaderName;
    private readonly _displayNameHeader;
    private readonly _emailHeader;
    constructor(config: HeaderIdentityProviderConfig);
    /** 从 Header 读取 user_id 并构造身份。 */
    resolve(context: IdentityContext): Promise<GovernorIdentity>;
}
/** JWT 密钥类型。HMAC 算法用 string；RSA/ECDSA 用 PEM 字符串、JWK 或 KeyObject。 */
export type JwtKey = string | JsonWebKey | KeyObject;
/** JwtIdentityProvider 配置。 */
export interface JwtIdentityProviderConfig {
    /** 允许的算法列表，如 ['RS256', 'ES256']。不能包含 'none'。必填。 */
    algorithms: readonly string[];
    /**
     * 验证签名的密钥。
     * HMAC 算法用字符串密钥；RSA/ECDSA 用 PEM 字符串、JWK 或 KeyObject。
     */
    key: JwtKey;
    /** 预期 issuer。配置后验证 JWT iss claim 必须匹配。 */
    issuer?: string;
    /** 预期 audience。配置后验证 JWT aud claim 必须匹配。 */
    audience?: string;
    /** 映射 userId 的 claim 名，默认 'sub'。 */
    subjectClaim?: string;
    /** 展示名 claim 名，如 'name'。 */
    displayNameClaim?: string;
    /** 邮箱 claim 名，如 'email'。 */
    emailClaim?: string;
    /** 时钟偏差（毫秒），默认 0。 */
    clockToleranceMs?: number;
    /** 从 Header 读取 JWT 的 Header 名（不区分大小写），默认 'authorization'。 */
    headerName?: string;
    /** Authorization scheme 前缀，默认 'Bearer '。设为空字符串禁用 scheme 检查。 */
    scheme?: string;
}
/**
 * JwtIdentityProvider：验证 JWT 签名、允许算法、issuer、audience、exp、nbf 后映射 subject claim。
 *
 * 安全约束：
 * - 禁止 alg=none
 * - 禁止只 decode 不 verify，必须验证签名
 * - 密钥轮换失败时拒绝新请求
 */
export declare class JwtIdentityProvider implements IdentityProvider {
    readonly kind = "jwt";
    private readonly _algorithms;
    private readonly _key;
    private readonly _issuer;
    private readonly _audience;
    private readonly _subjectClaim;
    private readonly _displayNameClaim;
    private readonly _emailClaim;
    private readonly _clockToleranceMs;
    private readonly _headerName;
    private readonly _scheme;
    constructor(config: JwtIdentityProviderConfig);
    /** 从 Header 读取 JWT，验证签名和 claims，返回身份。 */
    resolve(context: IdentityContext): Promise<GovernorIdentity>;
    /** 验证 JWT 签名和 claims，返回身份。 */
    private _verifyToken;
}
/** 第三方注册的自定义解析函数。 */
export type CustomResolveFn = (context: IdentityContext) => Promise<GovernorIdentity>;
/**
 * CustomIdentityProvider：包装第三方插件注册的 resolve 函数。
 * 由第三方插件向 ctx.governor.identity 注册。
 */
export declare class CustomIdentityProvider implements IdentityProvider {
    readonly kind: string;
    private readonly _resolveFn;
    constructor(resolveFn: CustomResolveFn, kind?: string);
    /** 调用第三方 resolve 函数，校验返回的 userId 非空。 */
    resolve(context: IdentityContext): Promise<GovernorIdentity>;
}
