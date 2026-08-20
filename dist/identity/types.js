/**
 * 身份模块类型定义。
 *
 * 领域层，不导入任何 DSH 包。GovernorIdentity 的治理主键只有 userId；
 * displayName/email/attributes 为展示属性，可保存受限 JSON。
 * Usage 和 Decision Record 不保存 Prompt、JWT、API Key 或完整 Header。
 */
/**
 * 身份解析错误。
 * 无绑定、绑定过期或 user_id 为空时 fail closed，抛出此错误。
 */
export class IdentityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'IdentityError';
        this.code = code;
    }
}
