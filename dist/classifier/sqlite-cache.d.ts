import type { GovernorRepository } from '../storage/repository.js';
import type { ClassifierCache, Classification } from './types.js';
/** 默认缓存 TTL（毫秒）：7 天（优化文档 7.1）。 */
export declare const CLASSIFIER_CACHE_TTL_MS: number;
/**
 * 构建 HMAC-SHA256 规范化输入哈希。
 *
 * @param canonicalInput - 规范化输入文本（JSON）。
 * @param hmacKey - HMAC 密钥。
 * @returns 小写十六进制摘要。
 */
export declare function hmacInputHash(canonicalInput: string, hmacKey: string): string;
/**
 * 构建完整缓存键（版本化合同：inputHash:route:promptVersion:revision:tenant）。
 */
export declare function buildClassifierCacheKey(inputHash: string, classifierRoute: string, promptVersion: string, configRevision: number, tenantScope?: string): string;
/**
 * SQLite 分类器缓存：读写 classifier_cache 表（HMAC 键 + TTL + revision 失效）。
 */
export declare class SQLiteClassifierCache implements ClassifierCache {
    private readonly _repo;
    private readonly _hmacKey;
    private readonly _ttlMs;
    private readonly _classifierRoute;
    private readonly _promptVersion;
    private readonly _tenantScope;
    constructor(repo: GovernorRepository, options?: {
        ttlMs?: number;
        classifierRoute?: string;
        promptVersion?: string;
        tenantScope?: string;
    });
    /** 读取缓存；TTL 过期视为 miss。 */
    get(key: string): Classification | undefined;
    /** 写入缓存（幂等 UPSERT）。 */
    set(key: string, value: Classification): void;
    /** 生成当前配置下的完整缓存键（供 index.ts 调用）。 */
    buildKey(canonicalInput: string, configRevision: number): string;
}
/**
 * Single-flight 包装：同一键的并发请求只触发一次底层调用。
 *
 * @returns 带去重的执行器。
 */
export declare function createSingleFlight(): {
    run: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
};
