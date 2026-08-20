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

/** 缓存条目。 */
interface CacheEntry {
  readonly value: Classification;
  /** 过期绝对时间戳（ms）；undefined 表示永不过期。 */
  readonly expiresAt?: number;
}

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
export class InMemoryClassifierCache implements ClassifierCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly defaultTtlMs?: number;

  constructor(options?: InMemoryClassifierCacheOptions) {
    const ttl = options?.ttlMs;
    // exactOptionalPropertyTypes：仅在有正数 TTL 时才赋值
    if (ttl !== undefined && ttl > 0) {
      this.defaultTtlMs = ttl;
    }
  }

  /** 取缓存；未命中或已过期返回 undefined。 */
  get(key: string): Classification | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** 写缓存；若配置了 TTL 则附带过期时间。 */
  set(key: string, value: Classification): void {
    const entry: CacheEntry = {
      value,
      ...(this.defaultTtlMs !== undefined ? { expiresAt: Date.now() + this.defaultTtlMs } : {}),
    };
    this.store.set(key, entry);
  }
}
