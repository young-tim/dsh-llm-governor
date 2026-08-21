/**
 * Governor 管理面的最小权限模型。
 *
 * 这里刻意不接受 Remote 参数中的 actor/user/role。调用主体只能由 Host
 * 注入的 resolver 返回；没有可信 resolver 时必须 fail closed。
 */

/** Governor 管理能力（GOV-SEC-001）。 */
export type GovernorCapability = 'governor.read' | 'governor.manage' | 'governor.audit';

/** Host 已认证并解析出的 Governor 主体。 */
export interface GovernorPrincipal {
  /** 用于管理审计的稳定主体标识。 */
  readonly id: string;
  /** Host 授予的能力；浏览器不能提交或覆盖。 */
  readonly capabilities: ReadonlySet<GovernorCapability>;
}

/** Host 请求上下文中的主体解析器。 */
export type GovernorPrincipalResolver = () =>
  GovernorPrincipal | undefined | Promise<GovernorPrincipal | undefined>;

/** 权限拒绝，供 HTTP/Remote 边界映射为稳定错误。 */
export class GovernorAuthorizationError extends Error {
  readonly code: 'UNAUTHORIZED' | 'FORBIDDEN';

  constructor(code: 'UNAUTHORIZED' | 'FORBIDDEN') {
    super(
      code === 'UNAUTHORIZED' ? 'Governor authentication is required' : 'Governor access denied',
    );
    this.name = 'GovernorAuthorizationError';
    this.code = code;
  }
}

/**
 * 解析并复核一项能力。未解析主体与缺少能力分别返回 401/403 语义。
 */
export async function requireGovernorCapability(
  resolver: GovernorPrincipalResolver,
  capability: GovernorCapability,
): Promise<GovernorPrincipal> {
  const principal = await resolver();
  if (principal === undefined) throw new GovernorAuthorizationError('UNAUTHORIZED');
  if (!principal.capabilities.has(capability)) throw new GovernorAuthorizationError('FORBIDDEN');
  return principal;
}

/** local 模式的进程所有者主体；仅由 Host 启动配置构造。 */
export function localOwnerPrincipal(id: string): GovernorPrincipal {
  return {
    id,
    capabilities: new Set<GovernorCapability>([
      'governor.read',
      'governor.manage',
      'governor.audit',
    ]),
  };
}
