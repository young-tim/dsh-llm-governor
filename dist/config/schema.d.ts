import type { TaskType, RoutingMode } from '../index.js';
/** 当前配置 Schema 版本。 */
export declare const SCHEMA_VERSION = 1;
/** 1x 倍率对应的 parts-per-million。 */
export declare const PPM_PER_MULTIPLIER = 1000000;
/** 1 Credit 对应的纳秒数。 */
export declare const NANOS_PER_CREDIT = 1000000000n;
/** 定点倍率，单位 parts-per-million；1x = 1_000_000 ppm。 */
export type MultiplierPpm = number;
/** Credits 的整数纳秒表示；1 Credit = 1_000_000_000 nanos。 */
export type CreditNanos = bigint;
/** 身份提供者类型。custom 表示运行时经 ctx.governor.extensions 注册。 */
export type IdentityProviderKind = 'local' | 'header' | 'jwt' | 'custom';
/** Credit First 无候选时的回退策略。 */
export type CreditFirstOnNoMatch = 'quality_first' | 'none';
/** Manual Fallback 的重选策略（§10.2：对剩余允许模型重新选择）。 */
export type FallbackStrategy = 'quality_first' | 'credit_first' | 'auto';
/** 身份配置。 */
export interface IdentityConfig {
    readonly provider: IdentityProviderKind;
    readonly localUserId?: string;
    readonly headerName?: string;
    /** header 模式：可信代理来源标识（必填，强制声明信任边界）。 */
    readonly trustedProxy?: string;
    /** header 模式：代理标识 Header 名（可选；配置后验证其值等于 trustedProxy）。 */
    readonly proxyHeaderName?: string;
    /** header 模式：展示名 Header 名。 */
    readonly displayNameHeader?: string;
    /** header 模式：邮箱 Header 名。 */
    readonly emailHeader?: string;
    readonly jwtIssuer?: string;
    readonly jwtAudience?: string;
    readonly jwtAlgorithms?: readonly string[];
    /** jwt 模式：签名密钥（HMAC 字符串或 PEM 字符串）。与 jwt_key_file 二选一。 */
    readonly jwtKey?: string;
    /** jwt 模式：从文件读取签名密钥（PEM）。与 jwt_key 二选一。 */
    readonly jwtKeyFile?: string;
    /** jwt 模式：映射 userId 的 claim 名，默认 sub。 */
    readonly jwtSubjectClaim?: string;
    /** jwt 模式：读取 JWT 的 Header 名，默认 authorization。 */
    readonly jwtHeaderName?: string;
    /** jwt 模式：Authorization scheme 前缀，默认 'Bearer '。 */
    readonly jwtScheme?: string;
    /** jwt 模式：时钟偏差（毫秒），默认 0。 */
    readonly jwtClockToleranceMs?: number;
}
/** Credits 计量配置。 */
export interface CreditsConfig {
    readonly tokensPerCredit: number;
    readonly timezone: string;
    readonly defaultMonthlyCredits: CreditNanos;
}
/** 路由配置。 */
export interface RoutingConfig {
    readonly default: RoutingMode;
    readonly creditFirst: {
        readonly minimumQuality: number;
        readonly onNoMatch: CreditFirstOnNoMatch;
    };
}
/** Auto 路由配置。 */
export interface AutoConfig {
    readonly confidenceThreshold: number;
    readonly qualityThreshold: {
        readonly low: number;
        readonly medium: number;
        readonly high: number;
    };
    readonly llmClassifier: {
        readonly enabled: boolean;
        readonly provider: string;
        readonly model: string;
        /** 单次分类调用的整体超时（毫秒），含等待首个 chunk 的时间。 */
        readonly timeoutMs: number;
    };
}
/** Fallback 配置。 */
export interface FallbackConfig {
    readonly enabled: boolean;
    readonly maxAttempts: number;
    readonly afterPartialOutput: boolean;
    /** Manual 模式失败后的重选策略（仅显式启用 Fallback 时生效，§10.2）。 */
    readonly strategy: FallbackStrategy;
}
/** SQLite 持久化配置。 */
export interface StorageConfig {
    readonly enabled: boolean;
    /** 数据库文件路径；空字符串表示使用默认 $DSH_HOME 路径。 */
    readonly path?: string;
}
/** Web UI 配置。 */
export interface UiConfig {
    readonly enabled: boolean;
    /** 无 webServer 时的独立监听端口；0 表示不独立监听。 */
    readonly port: number;
}
/** 单个模型条目配置。 */
export interface ModelEntryConfig {
    readonly enabled: boolean;
    readonly multiplierPpm: MultiplierPpm;
    readonly capabilities: readonly string[];
    readonly quality: Readonly<Partial<Record<TaskType, number>>>;
}
/** 单个用户条目配置。 */
export interface UserEntryConfig {
    readonly allow: readonly string[];
    readonly monthlyCredits: CreditNanos;
}
/** Governor 完整配置（经过验证和规范化后的不可变快照）。 */
export interface GovernorConfig {
    readonly schemaVersion: number;
    readonly revision: number;
    readonly identity: IdentityConfig;
    readonly credits: CreditsConfig;
    readonly routing: RoutingConfig;
    readonly auto: AutoConfig;
    readonly fallback: FallbackConfig;
    readonly models: Readonly<Record<string, ModelEntryConfig>>;
    readonly users: Readonly<Record<string, UserEntryConfig>>;
    readonly storage: StorageConfig;
    readonly ui: UiConfig;
    readonly compatApi?: CompatApiConfig;
}
/** 兼容 API 配置（GOV-UI-001：默认禁用，显式开启时仅 loopback）。 */
export interface CompatApiConfig {
    readonly enabled: boolean;
    readonly port?: number;
    readonly listen?: '127.0.0.1' | '[::1]';
    readonly token?: string;
    readonly allowedOrigin?: string;
}
/** 配置验证错误，携带稳定错误码和配置路径。 */
export declare class ConfigError extends Error {
    readonly code: string;
    readonly path: string;
    constructor(message: string, code: string, path: string);
}
/**
 * 验证并规范化配置。
 * 未知字段拒绝、应用默认值、倍率转 ppm、Credits 转 nanos。
 * 返回的 revision 初始化为 1。
 */
export declare function resolveConfig(raw: unknown): GovernorConfig;
/**
 * 将浮点倍率转为 parts-per-million 定点数。
 * 1x = 1_000_000 ppm。输入必须为有限非负数。
 */
export declare function multiplierToPpm(m: number): MultiplierPpm;
/**
 * 将 Credits 数量转为纳秒定点数。
 * 1 Credit = 1_000_000_000 nanos。
 * 注意：输入值不应超过 ~9_000_000，否则浮点乘法可能丢失精度。
 */
export declare function creditsToNanos(c: number): CreditNanos;
/**
 * 递增配置 revision（每次管理写入时调用）。
 * 返回新的不可变配置对象，原对象不变。
 */
export declare function bumpRevision(config: GovernorConfig): GovernorConfig;
/**
 * 设置配置的 revision（用于从持久层恢复配置时指定 revision）。
 * 返回新的不可变配置对象。
 */
export declare function withRevision(config: GovernorConfig, revision: number): GovernorConfig;
