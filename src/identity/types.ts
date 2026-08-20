/**
 * 身份模块类型定义。
 *
 * 领域层，不导入任何 DSH 包。GovernorIdentity 的治理主键只有 userId；
 * displayName/email/attributes 为展示属性，可保存受限 JSON。
 * Usage 和 Decision Record 不保存 Prompt、JWT、API Key 或完整 Header。
 */

/** 治理身份。治理主键只有 userId；其余为展示属性。 */
export interface GovernorIdentity {
  userId: string;
  displayName?: string;
  email?: string;
  attributes?: Readonly<Record<string, unknown>>;
}

/** 身份解析上下文。sessionId 必填；headers 来自可信反向代理入站边界。 */
export interface IdentityContext {
  sessionId: string;
  headers?: Readonly<Record<string, string>>;
}

/** 身份提供者接口。各实现从不同来源解析 GovernorIdentity。 */
export interface IdentityProvider {
  /** 提供者类型标识。 */
  readonly kind: string;
  /**
   * 从上下文解析身份。
   * 无身份或身份无效时抛 IdentityError（fail closed）。
   */
  resolve(context: IdentityContext): Promise<GovernorIdentity>;
}

/** 身份来源类型。 */
export type IdentitySource = 'local' | 'header' | 'jwt' | 'custom';

/** 身份错误码。 */
export type IdentityErrorCode = 'IDENTITY_REQUIRED' | 'IDENTITY_INVALID' | 'IDENTITY_EXPIRED';

/**
 * 身份解析错误。
 * 无绑定、绑定过期或 user_id 为空时 fail closed，抛出此错误。
 */
export class IdentityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}
