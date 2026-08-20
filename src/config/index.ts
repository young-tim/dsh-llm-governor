/**
 * 配置模块入口：导出 Schema 类型、验证函数和转换工具。
 */
export type {
  MultiplierPpm,
  CreditNanos,
  IdentityProvider,
  CreditFirstOnNoMatch,
  IdentityConfig,
  CreditsConfig,
  RoutingConfig,
  AutoConfig,
  FallbackConfig,
  StorageConfig,
  UiConfig,
  ModelEntryConfig,
  UserEntryConfig,
  GovernorConfig,
} from './schema.js';
export {
  ConfigError,
  resolveConfig,
  multiplierToPpm,
  creditsToNanos,
  bumpRevision,
  withRevision,
  SCHEMA_VERSION,
  PPM_PER_MULTIPLIER,
  NANOS_PER_CREDIT,
} from './schema.js';
