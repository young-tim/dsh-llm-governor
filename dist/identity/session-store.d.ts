/**
 * Session 身份绑定存储。
 *
 * 内存 Map 存储 session_id → { identity, source, expiresAt }。
 * 过期绑定在 resolve/has 时惰性清除。
 * 领域层，不导入任何 DSH 包。
 */
import type { GovernorIdentity, IdentitySource } from './types.js';
/**
 * SessionIdentityStore：内存 Map 存储 session 身份绑定。
 * Header/JWT 必须在创建 session 或提交首条消息的入站边界完成绑定。
 * 无绑定或绑定过期时 resolve 返回 undefined，由调用方 fail closed。
 */
export declare class SessionIdentityStore {
    private readonly _store;
    /** 绑定身份到 session。ttlMs 为可选存活时间（毫秒），不传则永不过期。 */
    bind(sessionId: string, identity: GovernorIdentity, source: IdentitySource, ttlMs?: number): void;
    /** 解析 session 绑定的身份；过期或不存在返回 undefined。 */
    resolve(sessionId: string): GovernorIdentity | undefined;
    /** 清除 session 绑定。 */
    clear(sessionId: string): void;
    /** 检查 session 是否有有效绑定（过期绑定会被清除并返回 false）。 */
    has(sessionId: string): boolean;
}
