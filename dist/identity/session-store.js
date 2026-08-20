/**
 * SessionIdentityStore：内存 Map 存储 session 身份绑定。
 * Header/JWT 必须在创建 session 或提交首条消息的入站边界完成绑定。
 * 无绑定或绑定过期时 resolve 返回 undefined，由调用方 fail closed。
 */
export class SessionIdentityStore {
    _store = new Map();
    /** 绑定身份到 session。ttlMs 为可选存活时间（毫秒），不传则永不过期。 */
    bind(sessionId, identity, source, ttlMs) {
        const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;
        this._store.set(sessionId, { identity, source, expiresAt });
    }
    /** 解析 session 绑定的身份；过期或不存在返回 undefined。 */
    resolve(sessionId) {
        const entry = this._store.get(sessionId);
        if (entry === undefined) {
            return undefined;
        }
        if (isExpired(entry)) {
            this._store.delete(sessionId);
            return undefined;
        }
        return entry.identity;
    }
    /** 清除 session 绑定。 */
    clear(sessionId) {
        this._store.delete(sessionId);
    }
    /** 检查 session 是否有有效绑定（过期绑定会被清除并返回 false）。 */
    has(sessionId) {
        const entry = this._store.get(sessionId);
        if (entry === undefined) {
            return false;
        }
        if (isExpired(entry)) {
            this._store.delete(sessionId);
            return false;
        }
        return true;
    }
}
/** 检查绑定是否已过期。 */
function isExpired(entry) {
    return entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
}
