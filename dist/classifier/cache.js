/** 进程内 Map 实现的分类结果缓存。
 *
 * - get：未命中或已过期返回 undefined，并惰性清理过期条目。
 * - set：写入新条目，按构造时配置的 TTL 计算过期时间。
 */
export class InMemoryClassifierCache {
    store = new Map();
    defaultTtlMs;
    constructor(options) {
        const ttl = options?.ttlMs;
        // exactOptionalPropertyTypes：仅在有正数 TTL 时才赋值
        if (ttl !== undefined && ttl > 0) {
            this.defaultTtlMs = ttl;
        }
    }
    /** 取缓存；未命中或已过期返回 undefined。 */
    get(key) {
        const entry = this.store.get(key);
        if (entry === undefined)
            return undefined;
        if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }
    /** 写缓存；若配置了 TTL 则附带过期时间。 */
    set(key, value) {
        const entry = {
            value,
            ...(this.defaultTtlMs !== undefined ? { expiresAt: Date.now() + this.defaultTtlMs } : {}),
        };
        this.store.set(key, entry);
    }
}
