/**
 * 分类结果缓存的内存实现。
 *
 * 同一输入 + 配置下的分类结果应稳定可复用，避免对轻量模型反复调用。
 * 可选 TTL 用于限制缓存生命周期；过期条目在 get 时惰性清理。
 *
 * 该类不做 LRU 或容量上限，调用方需自行控制写入量；
 * 进程级单例足够，跨进程缓存由 plugin 层持久化。
 */
import type { ClassifierCache, Classification } from './types.js';
/** InMemoryClassifierCache 构造选项。 */
export interface InMemoryClassifierCacheOptions {
    /** 默认 TTL（毫秒）；不传或 0 表示永不过期。 */
    ttlMs?: number;
}
/** 进程内 Map 实现的分类结果缓存。
 *
 * - get：未命中或已过期返回 undefined，并惰性清理过期条目。
 * - set：写入新条目，按构造时配置的 TTL 计算过期时间。
 */
export declare class InMemoryClassifierCache implements ClassifierCache {
    private readonly store;
    private readonly defaultTtlMs?;
    constructor(options?: InMemoryClassifierCacheOptions);
    /** 取缓存；未命中或已过期返回 undefined。 */
    get(key: string): Classification | undefined;
    /** 写缓存；若配置了 TTL 则附带过期时间。 */
    set(key: string, value: Classification): void;
}
