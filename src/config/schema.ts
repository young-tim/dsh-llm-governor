/**
 * Governor 配置 Schema：严格验证、默认值规范化、未知字段拒绝。
 * 这是纯领域层模块，不导入任何 DSH 包。
 */
import { TASK_TYPES } from '../index.js';
import type { TaskType, RoutingMode } from '../index.js';

// ===== 常量 =====

/** 当前配置 Schema 版本。 */
export const SCHEMA_VERSION = 1;

/** 1x 倍率对应的 parts-per-million。 */
export const PPM_PER_MULTIPLIER = 1_000_000;

/** 1 Credit 对应的纳秒数。 */
export const NANOS_PER_CREDIT = 1_000_000_000n;

/** Quality 取值下界（闭区间）。 */
const MIN_QUALITY = 0;

/** Quality 取值上界（闭区间）。 */
const MAX_QUALITY = 100;

/** 初始配置 revision。 */
const INITIAL_REVISION = 1;

// 默认值
const DEFAULT_TOKENS_PER_CREDIT = 1_000_000;
const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_MONTHLY_CREDITS = 100;
const DEFAULT_LOCAL_USER_ID = 'local';
const DEFAULT_ROUTING_MODE: RoutingMode = 'manual';
const DEFAULT_CREDIT_FIRST_MINIMUM_QUALITY = 0;
const DEFAULT_CREDIT_FIRST_ON_NO_MATCH: CreditFirstOnNoMatch = 'none';
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_QUALITY_LOW = 75;
const DEFAULT_QUALITY_MEDIUM = 85;
const DEFAULT_QUALITY_HIGH = 92;
const DEFAULT_LLM_CLASSIFIER_ENABLED = false;
const DEFAULT_LLM_CLASSIFIER_PROVIDER = '';
const DEFAULT_LLM_CLASSIFIER_MODEL = '';
const DEFAULT_FALLBACK_ENABLED = true;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_AFTER_PARTIAL_OUTPUT = false;
const DEFAULT_MODEL_ENABLED = true;
const DEFAULT_MODEL_MULTIPLIER = 1;

// 允许的字段名（用于未知字段拒绝）
const TOP_LEVEL_FIELDS: readonly string[] = [
  'schema_version',
  'identity',
  'credits',
  'routing',
  'auto',
  'fallback',
  'models',
  'users',
  'storage',
  'ui',
];
const IDENTITY_FIELDS: readonly string[] = [
  'provider',
  'local_user_id',
  'header_name',
  'trusted_proxy',
  'proxy_header_name',
  'display_name_header',
  'email_header',
  'jwt_issuer',
  'jwt_audience',
  'jwt_algorithms',
  'jwt_key',
  'jwt_key_file',
  'jwt_subject_claim',
  'jwt_header_name',
  'jwt_scheme',
  'jwt_clock_tolerance_ms',
];
const CREDITS_FIELDS: readonly string[] = [
  'tokens_per_credit',
  'timezone',
  'default_monthly_credits',
];
const ROUTING_FIELDS: readonly string[] = ['default', 'credit_first'];
const CREDIT_FIRST_FIELDS: readonly string[] = ['minimum_quality', 'on_no_match'];
const AUTO_FIELDS: readonly string[] = [
  'confidence_threshold',
  'quality_threshold',
  'llm_classifier',
];
const QUALITY_THRESHOLD_FIELDS: readonly string[] = ['low', 'medium', 'high'];
const LLM_CLASSIFIER_FIELDS: readonly string[] = ['enabled', 'provider', 'model'];
const FALLBACK_FIELDS: readonly string[] = ['enabled', 'max_attempts', 'after_partial_output'];
const MODEL_FIELDS: readonly string[] = ['enabled', 'multiplier', 'capabilities', 'quality'];
const USER_FIELDS: readonly string[] = ['allow', 'monthly_credits'];
const STORAGE_FIELDS: readonly string[] = ['enabled', 'path'];
const UI_FIELDS: readonly string[] = ['enabled', 'port'];

/** TaskType 集合，用于 O(1) 校验。 */
const TASK_TYPE_SET: ReadonlySet<string> = new Set<string>(TASK_TYPES);

// ===== 类型 =====

/** 定点倍率，单位 parts-per-million；1x = 1_000_000 ppm。 */
export type MultiplierPpm = number;

/** Credits 的整数纳秒表示；1 Credit = 1_000_000_000 nanos。 */
export type CreditNanos = bigint;

/** 身份提供者类型。 */
export type IdentityProvider = 'local' | 'header' | 'jwt';

/** Credit First 无候选时的回退策略。 */
export type CreditFirstOnNoMatch = 'quality_first' | 'none';

/** 身份配置。 */
export interface IdentityConfig {
  readonly provider: IdentityProvider;
  readonly localUserId?: string;
  readonly headerName?: string;
  /** header 模式：可信代理来源标识（必填，强制声明信任边界）。 */
  readonly trustedProxy?: string;
  /** header 模式：代理标识 Header 名（可选；配置后验证其值等于 trustedProxy）。 */
  readonly proxyHeaderName?: string;
  /** header 模式：展示名 Header 名。 */
  readonly displayNameHeader?: string;
  /** header 模式：邮箱 Header 名。 */
  readonly emailHeader?: string;
  readonly jwtIssuer?: string;
  readonly jwtAudience?: string;
  readonly jwtAlgorithms?: readonly string[];
  /** jwt 模式：签名密钥（HMAC 字符串或 PEM 字符串）。与 jwt_key_file 二选一。 */
  readonly jwtKey?: string;
  /** jwt 模式：从文件读取签名密钥（PEM）。与 jwt_key 二选一。 */
  readonly jwtKeyFile?: string;
  /** jwt 模式：映射 userId 的 claim 名，默认 sub。 */
  readonly jwtSubjectClaim?: string;
  /** jwt 模式：读取 JWT 的 Header 名，默认 authorization。 */
  readonly jwtHeaderName?: string;
  /** jwt 模式：Authorization scheme 前缀，默认 'Bearer '。 */
  readonly jwtScheme?: string;
  /** jwt 模式：时钟偏差（毫秒），默认 0。 */
  readonly jwtClockToleranceMs?: number;
}

/** Credits 计量配置。 */
export interface CreditsConfig {
  readonly tokensPerCredit: number;
  readonly timezone: string;
  readonly defaultMonthlyCredits: CreditNanos;
}

/** 路由配置。 */
export interface RoutingConfig {
  readonly default: RoutingMode;
  readonly creditFirst: {
    readonly minimumQuality: number;
    readonly onNoMatch: CreditFirstOnNoMatch;
  };
}

/** Auto 路由配置。 */
export interface AutoConfig {
  readonly confidenceThreshold: number;
  readonly qualityThreshold: {
    readonly low: number;
    readonly medium: number;
    readonly high: number;
  };
  readonly llmClassifier: {
    readonly enabled: boolean;
    readonly provider: string;
    readonly model: string;
  };
}

/** Fallback 配置。 */
export interface FallbackConfig {
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly afterPartialOutput: boolean;
}

/** SQLite 持久化配置。 */
export interface StorageConfig {
  readonly enabled: boolean;
  /** 数据库文件路径；空字符串表示使用默认 $DSH_HOME 路径。 */
  readonly path?: string;
}

/** Web UI 配置。 */
export interface UiConfig {
  readonly enabled: boolean;
  /** 无 webServer 时的独立监听端口；0 表示不独立监听。 */
  readonly port: number;
}

/** 单个模型条目配置。 */
export interface ModelEntryConfig {
  readonly enabled: boolean;
  readonly multiplierPpm: MultiplierPpm;
  readonly capabilities: readonly string[];
  readonly quality: Readonly<Partial<Record<TaskType, number>>>;
}

/** 单个用户条目配置。 */
export interface UserEntryConfig {
  readonly allow: readonly string[];
  readonly monthlyCredits: CreditNanos;
}

/** Governor 完整配置（经过验证和规范化后的不可变快照）。 */
export interface GovernorConfig {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly identity: IdentityConfig;
  readonly credits: CreditsConfig;
  readonly routing: RoutingConfig;
  readonly auto: AutoConfig;
  readonly fallback: FallbackConfig;
  readonly models: Readonly<Record<string, ModelEntryConfig>>;
  readonly users: Readonly<Record<string, UserEntryConfig>>;
  readonly storage: StorageConfig;
  readonly ui: UiConfig;
}

// ===== 错误 =====

/** 配置验证错误，携带稳定错误码和配置路径。 */
export class ConfigError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(message: string, code: string, path: string) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
    this.code = code;
    this.path = path;
  }
}

// ===== 验证辅助函数 =====

/** 判断值是否为普通对象（非 null、非数组）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 拒绝未知字段；遍历对象键，遇到不在 allowed 列表中的键即抛错。 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`unknown field "${key}"`, 'CONFIG_UNKNOWN_FIELD', `${path}.${key}`);
    }
  }
}

/** 解析字符串，类型不符则抛错。 */
function parseString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new ConfigError(`expected string, got ${typeof value}`, 'CONFIG_TYPE_ERROR', path);
  }
  return value;
}

/** 解析非空字符串。 */
function parseNonEmptyString(value: unknown, path: string): string {
  const s = parseString(value, path);
  if (s.length === 0) {
    throw new ConfigError('expected non-empty string', 'CONFIG_EMPTY_STRING', path);
  }
  return s;
}

/** 解析有限数字。 */
function parseNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`expected finite number, got ${typeof value}`, 'CONFIG_TYPE_ERROR', path);
  }
  return value;
}

/** 解析非负有限数字。 */
function parseNonNegativeNumber(value: unknown, path: string): number {
  const n = parseNumber(value, path);
  if (n < 0) {
    throw new ConfigError(`expected non-negative number, got ${n}`, 'CONFIG_RANGE_ERROR', path);
  }
  return n;
}

/** 解析正整数（>= 1）。 */
function parsePositiveInteger(value: unknown, path: string): number {
  const n = parseNumber(value, path);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(`expected positive integer, got ${n}`, 'CONFIG_RANGE_ERROR', path);
  }
  return n;
}

/** 解析布尔值。 */
function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`expected boolean, got ${typeof value}`, 'CONFIG_TYPE_ERROR', path);
  }
  return value;
}

/** 解析字符串数组。 */
function parseStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`expected array, got ${typeof value}`, 'CONFIG_TYPE_ERROR', path);
  }
  return value.map((v, i) => parseString(v, `${path}[${i}]`));
}

/** 解析 Quality 值（闭区间 0..100）。 */
function parseQualityValue(value: unknown, path: string): number {
  const n = parseNumber(value, path);
  if (n < MIN_QUALITY || n > MAX_QUALITY) {
    throw new ConfigError(`expected quality in [0, 100], got ${n}`, 'CONFIG_RANGE_ERROR', path);
  }
  return n;
}

/** 解析闭区间 [0, 1] 数字。 */
function parseUnitInterval(value: unknown, path: string): number {
  const n = parseNumber(value, path);
  if (n < 0 || n > 1) {
    throw new ConfigError(`expected number in [0, 1], got ${n}`, 'CONFIG_RANGE_ERROR', path);
  }
  return n;
}

/** 校验 IANA 时区字符串。 */
function parseTimezone(value: unknown, path: string): string {
  const tz = parseNonEmptyString(value, path);
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new ConfigError(`invalid IANA timezone "${tz}"`, 'CONFIG_INVALID_TIMEZONE', path);
  }
  return tz;
}

/** 解析 IdentityProvider 枚举。 */
function parseIdentityProvider(value: unknown, path: string): IdentityProvider {
  const s = parseString(value, path);
  if (s !== 'local' && s !== 'header' && s !== 'jwt') {
    throw new ConfigError(
      `provider must be local|header|jwt, got "${s}"`,
      'CONFIG_INVALID_PROVIDER',
      path,
    );
  }
  return s;
}

/** 解析 RoutingMode 枚举。 */
function parseRoutingMode(value: unknown, path: string): RoutingMode {
  const s = parseString(value, path);
  if (s !== 'manual' && s !== 'quality_first' && s !== 'credit_first' && s !== 'auto') {
    throw new ConfigError(
      `routing mode must be manual|quality_first|credit_first|auto, got "${s}"`,
      'CONFIG_INVALID_ROUTING_MODE',
      path,
    );
  }
  return s;
}

/** 解析 CreditFirstOnNoMatch 枚举。 */
function parseOnNoMatch(value: unknown, path: string): CreditFirstOnNoMatch {
  const s = parseString(value, path);
  if (s !== 'quality_first' && s !== 'none') {
    throw new ConfigError(
      `on_no_match must be quality_first|none, got "${s}"`,
      'CONFIG_INVALID_ON_NO_MATCH',
      path,
    );
  }
  return s;
}

/** 校验 route_id 格式为 provider:model（非空 provider、单个冒号、非空 model）。 */
function parseRouteId(key: string, path: string): void {
  const colonIdx = key.indexOf(':');
  if (colonIdx <= 0 || colonIdx === key.length - 1) {
    throw new ConfigError(
      `route id must be "provider:model" format`,
      'CONFIG_INVALID_ROUTE_ID',
      `${path}.${key}`,
    );
  }
}

/** 判断字符串是否为合法 TaskType。 */
function isValidTaskType(key: string): key is TaskType {
  return TASK_TYPE_SET.has(key);
}

/** 解析 Quality 映射，键必须是合法 TaskType，值必须在 [0, 100]。 */
function parseQuality(value: unknown, path: string): Partial<Record<TaskType, number>> {
  if (!isObject(value)) {
    throw new ConfigError(`expected object, got ${typeof value}`, 'CONFIG_TYPE_ERROR', path);
  }
  const result: Partial<Record<TaskType, number>> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!isValidTaskType(key)) {
      throw new ConfigError(
        `unknown task type "${key}"`,
        'CONFIG_UNKNOWN_TASK_TYPE',
        `${path}.${key}`,
      );
    }
    result[key] = parseQualityValue(v, `${path}.${key}`);
  }
  return result;
}

/** 解析 schema_version（必须存在且等于当前版本）。 */
function parseSchemaVersion(value: unknown): number {
  if (value === undefined) {
    throw new ConfigError('schema_version is required', 'CONFIG_MISSING_FIELD', 'schema_version');
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(
      `schema_version must be integer ${SCHEMA_VERSION}`,
      'CONFIG_SCHEMA_VERSION',
      'schema_version',
    );
  }
  if (value !== SCHEMA_VERSION) {
    throw new ConfigError(
      `schema_version must be ${SCHEMA_VERSION}, got ${value}`,
      'CONFIG_SCHEMA_VERSION',
      'schema_version',
    );
  }
  return value;
}

// ===== Section 解析器 =====

/** 解析 identity 配置块。 */
function parseIdentity(value: unknown): IdentityConfig {
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'identity');
  }
  rejectUnknownKeys(value, IDENTITY_FIELDS, 'identity');

  // provider 必填
  if (value['provider'] === undefined) {
    throw new ConfigError('provider is required', 'CONFIG_MISSING_FIELD', 'identity.provider');
  }
  const provider = parseIdentityProvider(value['provider'], 'identity.provider');

  // 条件必填校验
  if (provider === 'header') {
    if (value['header_name'] === undefined) {
      throw new ConfigError(
        'header_name is required when provider=header',
        'CONFIG_MISSING_FIELD',
        'identity.header_name',
      );
    }
    // 强制声明可信代理来源（信任边界不可缺省）
    if (value['trusted_proxy'] === undefined) {
      throw new ConfigError(
        'trusted_proxy is required when provider=header (trust boundary must be explicit)',
        'CONFIG_MISSING_FIELD',
        'identity.trusted_proxy',
      );
    }
  }
  if (provider === 'jwt') {
    if (value['jwt_issuer'] === undefined) {
      throw new ConfigError(
        'jwt_issuer is required when provider=jwt',
        'CONFIG_MISSING_FIELD',
        'identity.jwt_issuer',
      );
    }
    if (value['jwt_audience'] === undefined) {
      throw new ConfigError(
        'jwt_audience is required when provider=jwt',
        'CONFIG_MISSING_FIELD',
        'identity.jwt_audience',
      );
    }
    if (value['jwt_algorithms'] === undefined) {
      throw new ConfigError(
        'jwt_algorithms is required when provider=jwt',
        'CONFIG_MISSING_FIELD',
        'identity.jwt_algorithms',
      );
    }
    // 签名密钥必须显式提供（禁止无密钥的"只 decode"部署）
    if (value['jwt_key'] === undefined && value['jwt_key_file'] === undefined) {
      throw new ConfigError(
        'jwt_key or jwt_key_file is required when provider=jwt',
        'CONFIG_MISSING_FIELD',
        'identity.jwt_key',
      );
    }
    if (value['jwt_key'] !== undefined && value['jwt_key_file'] !== undefined) {
      throw new ConfigError(
        'jwt_key and jwt_key_file are mutually exclusive',
        'CONFIG_CONFLICT',
        'identity.jwt_key',
      );
    }
  }

  // 解析可选字段；provider=local 时 local_user_id 默认 "local"
  const localUserId =
    value['local_user_id'] !== undefined
      ? parseNonEmptyString(value['local_user_id'], 'identity.local_user_id')
      : provider === 'local'
        ? DEFAULT_LOCAL_USER_ID
        : undefined;
  const headerName =
    value['header_name'] !== undefined
      ? parseNonEmptyString(value['header_name'], 'identity.header_name')
      : undefined;
  const trustedProxy =
    value['trusted_proxy'] !== undefined
      ? parseNonEmptyString(value['trusted_proxy'], 'identity.trusted_proxy')
      : undefined;
  const proxyHeaderName =
    value['proxy_header_name'] !== undefined
      ? parseNonEmptyString(value['proxy_header_name'], 'identity.proxy_header_name')
      : undefined;
  const displayNameHeader =
    value['display_name_header'] !== undefined
      ? parseNonEmptyString(value['display_name_header'], 'identity.display_name_header')
      : undefined;
  const emailHeader =
    value['email_header'] !== undefined
      ? parseNonEmptyString(value['email_header'], 'identity.email_header')
      : undefined;
  const jwtIssuer =
    value['jwt_issuer'] !== undefined
      ? parseNonEmptyString(value['jwt_issuer'], 'identity.jwt_issuer')
      : undefined;
  const jwtAudience =
    value['jwt_audience'] !== undefined
      ? parseNonEmptyString(value['jwt_audience'], 'identity.jwt_audience')
      : undefined;
  const jwtAlgorithms =
    value['jwt_algorithms'] !== undefined
      ? parseStringArray(value['jwt_algorithms'], 'identity.jwt_algorithms')
      : undefined;
  const jwtKey =
    value['jwt_key'] !== undefined ? parseString(value['jwt_key'], 'identity.jwt_key') : undefined;
  const jwtKeyFile =
    value['jwt_key_file'] !== undefined
      ? parseNonEmptyString(value['jwt_key_file'], 'identity.jwt_key_file')
      : undefined;
  const jwtSubjectClaim =
    value['jwt_subject_claim'] !== undefined
      ? parseNonEmptyString(value['jwt_subject_claim'], 'identity.jwt_subject_claim')
      : undefined;
  const jwtHeaderName =
    value['jwt_header_name'] !== undefined
      ? parseNonEmptyString(value['jwt_header_name'], 'identity.jwt_header_name')
      : undefined;
  const jwtScheme =
    value['jwt_scheme'] !== undefined
      ? parseString(value['jwt_scheme'], 'identity.jwt_scheme')
      : undefined;
  const jwtClockToleranceMs =
    value['jwt_clock_tolerance_ms'] !== undefined
      ? parseNonNegativeNumber(value['jwt_clock_tolerance_ms'], 'identity.jwt_clock_tolerance_ms')
      : undefined;

  // jwt_algorithms 不允许为空数组
  if (jwtAlgorithms !== undefined && jwtAlgorithms.length === 0) {
    throw new ConfigError(
      'jwt_algorithms must not be empty',
      'CONFIG_EMPTY_ARRAY',
      'identity.jwt_algorithms',
    );
  }

  return {
    provider,
    ...(localUserId !== undefined ? { localUserId } : {}),
    ...(headerName !== undefined ? { headerName } : {}),
    ...(trustedProxy !== undefined ? { trustedProxy } : {}),
    ...(proxyHeaderName !== undefined ? { proxyHeaderName } : {}),
    ...(displayNameHeader !== undefined ? { displayNameHeader } : {}),
    ...(emailHeader !== undefined ? { emailHeader } : {}),
    ...(jwtIssuer !== undefined ? { jwtIssuer } : {}),
    ...(jwtAudience !== undefined ? { jwtAudience } : {}),
    ...(jwtAlgorithms !== undefined ? { jwtAlgorithms: [...jwtAlgorithms] } : {}),
    ...(jwtKey !== undefined ? { jwtKey } : {}),
    ...(jwtKeyFile !== undefined ? { jwtKeyFile } : {}),
    ...(jwtSubjectClaim !== undefined ? { jwtSubjectClaim } : {}),
    ...(jwtHeaderName !== undefined ? { jwtHeaderName } : {}),
    ...(jwtScheme !== undefined ? { jwtScheme } : {}),
    ...(jwtClockToleranceMs !== undefined ? { jwtClockToleranceMs } : {}),
  };
}

/** 解析 credits 配置块。 */
function parseCredits(value: unknown): CreditsConfig {
  if (value === undefined || value === null) {
    return {
      tokensPerCredit: DEFAULT_TOKENS_PER_CREDIT,
      timezone: DEFAULT_TIMEZONE,
      defaultMonthlyCredits: creditsToNanos(DEFAULT_MONTHLY_CREDITS),
    };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'credits');
  }
  rejectUnknownKeys(value, CREDITS_FIELDS, 'credits');

  const tokensPerCredit =
    value['tokens_per_credit'] !== undefined
      ? parsePositiveInteger(value['tokens_per_credit'], 'credits.tokens_per_credit')
      : DEFAULT_TOKENS_PER_CREDIT;
  const timezone =
    value['timezone'] !== undefined
      ? parseTimezone(value['timezone'], 'credits.timezone')
      : DEFAULT_TIMEZONE;
  const defaultMonthlyCredits =
    value['default_monthly_credits'] !== undefined
      ? creditsToNanos(
          parseNonNegativeNumber(
            value['default_monthly_credits'],
            'credits.default_monthly_credits',
          ),
        )
      : creditsToNanos(DEFAULT_MONTHLY_CREDITS);

  return { tokensPerCredit, timezone, defaultMonthlyCredits };
}

/** 解析 credit_first 子块。 */
function parseCreditFirst(value: unknown): RoutingConfig['creditFirst'] {
  if (value === undefined || value === null) {
    return {
      minimumQuality: DEFAULT_CREDIT_FIRST_MINIMUM_QUALITY,
      onNoMatch: DEFAULT_CREDIT_FIRST_ON_NO_MATCH,
    };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'routing.credit_first');
  }
  rejectUnknownKeys(value, CREDIT_FIRST_FIELDS, 'routing.credit_first');

  const minimumQuality =
    value['minimum_quality'] !== undefined
      ? parseQualityValue(value['minimum_quality'], 'routing.credit_first.minimum_quality')
      : DEFAULT_CREDIT_FIRST_MINIMUM_QUALITY;
  const onNoMatch =
    value['on_no_match'] !== undefined
      ? parseOnNoMatch(value['on_no_match'], 'routing.credit_first.on_no_match')
      : DEFAULT_CREDIT_FIRST_ON_NO_MATCH;

  return { minimumQuality, onNoMatch };
}

/** 解析 routing 配置块。 */
function parseRouting(value: unknown): RoutingConfig {
  if (value === undefined || value === null) {
    return {
      default: DEFAULT_ROUTING_MODE,
      creditFirst: {
        minimumQuality: DEFAULT_CREDIT_FIRST_MINIMUM_QUALITY,
        onNoMatch: DEFAULT_CREDIT_FIRST_ON_NO_MATCH,
      },
    };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'routing');
  }
  rejectUnknownKeys(value, ROUTING_FIELDS, 'routing');

  const defaultMode =
    value['default'] !== undefined
      ? parseRoutingMode(value['default'], 'routing.default')
      : DEFAULT_ROUTING_MODE;
  const creditFirst = parseCreditFirst(value['credit_first']);

  return { default: defaultMode, creditFirst };
}

/** 解析 quality_threshold 子块。 */
function parseQualityThreshold(value: unknown): AutoConfig['qualityThreshold'] {
  if (value === undefined || value === null) {
    return {
      low: DEFAULT_QUALITY_LOW,
      medium: DEFAULT_QUALITY_MEDIUM,
      high: DEFAULT_QUALITY_HIGH,
    };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'auto.quality_threshold');
  }
  rejectUnknownKeys(value, QUALITY_THRESHOLD_FIELDS, 'auto.quality_threshold');

  const low =
    value['low'] !== undefined
      ? parseQualityValue(value['low'], 'auto.quality_threshold.low')
      : DEFAULT_QUALITY_LOW;
  const medium =
    value['medium'] !== undefined
      ? parseQualityValue(value['medium'], 'auto.quality_threshold.medium')
      : DEFAULT_QUALITY_MEDIUM;
  const high =
    value['high'] !== undefined
      ? parseQualityValue(value['high'], 'auto.quality_threshold.high')
      : DEFAULT_QUALITY_HIGH;

  return { low, medium, high };
}

/** 解析 llm_classifier 子块。 */
function parseLlmClassifier(value: unknown): AutoConfig['llmClassifier'] {
  if (value === undefined || value === null) {
    return {
      enabled: DEFAULT_LLM_CLASSIFIER_ENABLED,
      provider: DEFAULT_LLM_CLASSIFIER_PROVIDER,
      model: DEFAULT_LLM_CLASSIFIER_MODEL,
    };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'auto.llm_classifier');
  }
  rejectUnknownKeys(value, LLM_CLASSIFIER_FIELDS, 'auto.llm_classifier');

  const enabled =
    value['enabled'] !== undefined
      ? parseBoolean(value['enabled'], 'auto.llm_classifier.enabled')
      : DEFAULT_LLM_CLASSIFIER_ENABLED;
  const provider =
    value['provider'] !== undefined
      ? parseNonEmptyString(value['provider'], 'auto.llm_classifier.provider')
      : DEFAULT_LLM_CLASSIFIER_PROVIDER;
  const model =
    value['model'] !== undefined
      ? parseNonEmptyString(value['model'], 'auto.llm_classifier.model')
      : DEFAULT_LLM_CLASSIFIER_MODEL;

  // 启用时 provider 和 model 必填
  if (enabled && (provider.length === 0 || model.length === 0)) {
    throw new ConfigError(
      'llm_classifier.provider and llm_classifier.model are required when enabled',
      'CONFIG_MISSING_FIELD',
      'auto.llm_classifier',
    );
  }

  return { enabled, provider, model };
}

/** 解析 auto 配置块。 */
function parseAuto(value: unknown): AutoConfig {
  if (value === undefined || value === null) {
    return {
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      qualityThreshold: {
        low: DEFAULT_QUALITY_LOW,
        medium: DEFAULT_QUALITY_MEDIUM,
        high: DEFAULT_QUALITY_HIGH,
      },
      llmClassifier: {
        enabled: DEFAULT_LLM_CLASSIFIER_ENABLED,
        provider: DEFAULT_LLM_CLASSIFIER_PROVIDER,
        model: DEFAULT_LLM_CLASSIFIER_MODEL,
      },
    };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'auto');
  }
  rejectUnknownKeys(value, AUTO_FIELDS, 'auto');

  const confidenceThreshold =
    value['confidence_threshold'] !== undefined
      ? parseUnitInterval(value['confidence_threshold'], 'auto.confidence_threshold')
      : DEFAULT_CONFIDENCE_THRESHOLD;
  const qualityThreshold = parseQualityThreshold(value['quality_threshold']);
  const llmClassifier = parseLlmClassifier(value['llm_classifier']);

  return { confidenceThreshold, qualityThreshold, llmClassifier };
}

/** 解析 fallback 配置块。 */
function parseFallback(value: unknown): FallbackConfig {
  if (value === undefined || value === null) {
    return {
      enabled: DEFAULT_FALLBACK_ENABLED,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      afterPartialOutput: DEFAULT_AFTER_PARTIAL_OUTPUT,
    };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'fallback');
  }
  rejectUnknownKeys(value, FALLBACK_FIELDS, 'fallback');

  const enabled =
    value['enabled'] !== undefined
      ? parseBoolean(value['enabled'], 'fallback.enabled')
      : DEFAULT_FALLBACK_ENABLED;
  const maxAttempts =
    value['max_attempts'] !== undefined
      ? parsePositiveInteger(value['max_attempts'], 'fallback.max_attempts')
      : DEFAULT_MAX_ATTEMPTS;
  const afterPartialOutput =
    value['after_partial_output'] !== undefined
      ? parseBoolean(value['after_partial_output'], 'fallback.after_partial_output')
      : DEFAULT_AFTER_PARTIAL_OUTPUT;

  return { enabled, maxAttempts, afterPartialOutput };
}

/** 解析单个模型条目。 */
function parseModelEntry(value: unknown, path: string): ModelEntryConfig {
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', path);
  }
  rejectUnknownKeys(value, MODEL_FIELDS, path);

  const enabled =
    value['enabled'] !== undefined
      ? parseBoolean(value['enabled'], `${path}.enabled`)
      : DEFAULT_MODEL_ENABLED;
  const multiplier =
    value['multiplier'] !== undefined
      ? parseNonNegativeNumber(value['multiplier'], `${path}.multiplier`)
      : DEFAULT_MODEL_MULTIPLIER;
  const capabilities =
    value['capabilities'] !== undefined
      ? parseStringArray(value['capabilities'], `${path}.capabilities`)
      : [];
  const quality =
    value['quality'] !== undefined ? parseQuality(value['quality'], `${path}.quality`) : {};

  return {
    enabled,
    multiplierPpm: multiplierToPpm(multiplier),
    capabilities: [...capabilities],
    quality,
  };
}

/** 解析 models 配置块（键为 provider:model 路由）。 */
function parseModels(value: unknown): Record<string, ModelEntryConfig> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'models');
  }
  const result: Record<string, ModelEntryConfig> = {};
  for (const [routeId, entry] of Object.entries(value)) {
    parseRouteId(routeId, 'models');
    result[routeId] = parseModelEntry(entry, `models.${routeId}`);
  }
  return result;
}

/** 解析单个用户条目。 */
function parseUserEntry(value: unknown, path: string): UserEntryConfig {
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', path);
  }
  rejectUnknownKeys(value, USER_FIELDS, path);

  const allow =
    value['allow'] !== undefined ? parseStringArray(value['allow'], `${path}.allow`) : [];
  const monthlyCredits =
    value['monthly_credits'] !== undefined
      ? creditsToNanos(parseNonNegativeNumber(value['monthly_credits'], `${path}.monthly_credits`))
      : creditsToNanos(DEFAULT_MONTHLY_CREDITS);

  return { allow: [...allow], monthlyCredits };
}

/** 解析 users 配置块。 */
function parseUsers(value: unknown): Record<string, UserEntryConfig> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'users');
  }
  const result: Record<string, UserEntryConfig> = {};
  for (const [userId, entry] of Object.entries(value)) {
    if (userId.length === 0) {
      throw new ConfigError('user id must not be empty', 'CONFIG_EMPTY_STRING', 'users.<empty>');
    }
    result[userId] = parseUserEntry(entry, `users.${userId}`);
  }
  return result;
}

/** 解析 storage 配置块。 */
function parseStorage(value: unknown): StorageConfig {
  if (value === undefined || value === null) {
    return { enabled: true };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'storage');
  }
  rejectUnknownKeys(value, STORAGE_FIELDS, 'storage');

  const enabled =
    value['enabled'] !== undefined ? parseBoolean(value['enabled'], 'storage.enabled') : true;
  const path =
    value['path'] !== undefined ? parseNonEmptyString(value['path'], 'storage.path') : undefined;

  return { enabled, ...(path !== undefined ? { path } : {}) };
}

/** 解析 ui 配置块。 */
function parseUi(value: unknown): UiConfig {
  if (value === undefined || value === null) {
    return { enabled: true, port: 0 };
  }
  if (!isObject(value)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'ui');
  }
  rejectUnknownKeys(value, UI_FIELDS, 'ui');

  const enabled =
    value['enabled'] !== undefined ? parseBoolean(value['enabled'], 'ui.enabled') : true;
  const port =
    value['port'] !== undefined
      ? (() => {
          const p = parsePositiveInteger(value['port'], 'ui.port');
          if (p > 65535) {
            throw new ConfigError(
              `expected port in [1, 65535], got ${p}`,
              'CONFIG_RANGE_ERROR',
              'ui.port',
            );
          }
          return p;
        })()
      : 0;

  return { enabled, port };
}

// ===== 主解析器 =====

/**
 * 验证并规范化配置。
 * 未知字段拒绝、应用默认值、倍率转 ppm、Credits 转 nanos。
 * 返回的 revision 初始化为 1。
 */
export function resolveConfig(raw: unknown): GovernorConfig {
  if (!isObject(raw)) {
    throw new ConfigError('expected object', 'CONFIG_TYPE_ERROR', 'root');
  }
  rejectUnknownKeys(raw, TOP_LEVEL_FIELDS, 'root');

  const schemaVersion = parseSchemaVersion(raw['schema_version']);

  // identity 必填
  if (raw['identity'] === undefined) {
    throw new ConfigError('identity is required', 'CONFIG_MISSING_FIELD', 'identity');
  }
  const identity = parseIdentity(raw['identity']);
  const credits = parseCredits(raw['credits']);
  const routing = parseRouting(raw['routing']);
  const auto = parseAuto(raw['auto']);
  const fallback = parseFallback(raw['fallback']);
  const models = parseModels(raw['models']);
  const users = parseUsers(raw['users']);
  const storage = parseStorage(raw['storage']);
  const ui = parseUi(raw['ui']);

  return {
    schemaVersion,
    revision: INITIAL_REVISION,
    identity,
    credits,
    routing,
    auto,
    fallback,
    models,
    users,
    storage,
    ui,
  };
}

// ===== 转换函数 =====

/**
 * 将浮点倍率转为 parts-per-million 定点数。
 * 1x = 1_000_000 ppm。输入必须为有限非负数。
 */
export function multiplierToPpm(m: number): MultiplierPpm {
  if (!Number.isFinite(m) || m < 0) {
    throw new ConfigError(
      'multiplier must be finite and non-negative',
      'CONFIG_RANGE_ERROR',
      'multiplier',
    );
  }
  return Math.round(m * PPM_PER_MULTIPLIER);
}

/**
 * 将 Credits 数量转为纳秒定点数。
 * 1 Credit = 1_000_000_000 nanos。
 * 注意：输入值不应超过 ~9_000_000，否则浮点乘法可能丢失精度。
 */
export function creditsToNanos(c: number): CreditNanos {
  if (!Number.isFinite(c) || c < 0) {
    throw new ConfigError(
      'credits must be finite and non-negative',
      'CONFIG_RANGE_ERROR',
      'credits',
    );
  }
  return BigInt(Math.round(c * Number(NANOS_PER_CREDIT)));
}

// ===== Revision 管理 =====

/**
 * 递增配置 revision（每次管理写入时调用）。
 * 返回新的不可变配置对象，原对象不变。
 */
export function bumpRevision(config: GovernorConfig): GovernorConfig {
  return { ...config, revision: config.revision + 1 };
}

/**
 * 设置配置的 revision（用于从持久层恢复配置时指定 revision）。
 * 返回新的不可变配置对象。
 */
export function withRevision(config: GovernorConfig, revision: number): GovernorConfig {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ConfigError('revision must be a positive integer', 'CONFIG_RANGE_ERROR', 'revision');
  }
  return { ...config, revision };
}
