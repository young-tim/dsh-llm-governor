/**
 * Governor 管理面的最小权限模型。
 *
 * 这里刻意不接受 Remote 参数中的 actor/user/role。调用主体只能由 Host
 * 注入的 resolver 返回；没有可信 resolver 时必须 fail closed。
 */
/** 权限拒绝，供 HTTP/Remote 边界映射为稳定错误。 */
export class GovernorAuthorizationError extends Error {
    code;
    constructor(code) {
        super(code === 'UNAUTHORIZED' ? 'Governor authentication is required' : 'Governor access denied');
        this.name = 'GovernorAuthorizationError';
        this.code = code;
    }
}
/**
 * 解析并复核一项能力。未解析主体与缺少能力分别返回 401/403 语义。
 */
export async function requireGovernorCapability(resolver, capability) {
    const principal = await resolver();
    if (principal === undefined)
        throw new GovernorAuthorizationError('UNAUTHORIZED');
    if (!principal.capabilities.has(capability))
        throw new GovernorAuthorizationError('FORBIDDEN');
    return principal;
}
/** local 模式的进程所有者主体；仅由 Host 启动配置构造。 */
export function localOwnerPrincipal(id) {
    return {
        id,
        capabilities: new Set([
            'governor.read',
            'governor.manage',
            'governor.audit',
        ]),
    };
}
