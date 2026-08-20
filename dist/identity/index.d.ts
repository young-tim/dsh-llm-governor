/**
 * 身份模块入口：导出类型、Provider 实现和 session 存储。
 */
export type { GovernorIdentity, IdentityContext, IdentityProvider, IdentitySource, IdentityErrorCode, } from './types.js';
export { IdentityError } from './types.js';
export { LocalIdentityProvider, HeaderIdentityProvider, JwtIdentityProvider, CustomIdentityProvider, } from './providers.js';
export type { LocalIdentityProviderConfig, HeaderIdentityProviderConfig, JwtIdentityProviderConfig, JwtKey, CustomResolveFn, } from './providers.js';
export { SessionIdentityStore } from './session-store.js';
