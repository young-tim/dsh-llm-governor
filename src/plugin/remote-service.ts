/**
 * DSH Typert Remote 的 Governor Host façade。
 *
 * 安全边界：所有公开方法都不接收 actor/user/role/capabilities；主体只能由
 * Host 注入的 GovernorPrincipalResolver 解析。local 模式可解析为进程所有者，
 * header/jwt/custom 模式在 Host 没有请求级 principal seam 时 fail closed。
 */
import { Remote, TypertLookupFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '../dsh-adapter/mod.js';
import type {
  GovernorCapability,
  GovernorPrincipal,
  GovernorPrincipalResolver,
} from '../security/governor-capabilities.js';
import {
  GovernorAuthorizationError,
  requireGovernorCapability,
} from '../security/governor-capabilities.js';
import type {
  GovernorRoutingSettingsPatch,
  GovernorService,
  GovernorUsageQuery,
} from './service.js';
import {
  GOVERNOR_USAGE_MAX_DAYS,
  GOVERNOR_USAGE_MAX_ROWS,
  normalizeGovernorUsageQuery,
} from './service.js';
import { RoutingError } from '../routing/types.js';

/** Remote 请求体上限（与兼容 API 相同）。 */
export const GOVERNOR_REMOTE_MAX_BYTES = 256 * 1024;
/** 向后兼容的 Remote 边界常量别名。 */
export const GOVERNOR_REMOTE_USAGE_MAX_DAYS = GOVERNOR_USAGE_MAX_DAYS;
export const GOVERNOR_REMOTE_USAGE_MAX_ROWS = GOVERNOR_USAGE_MAX_ROWS;

/** 每个 Remote 方法在 Host 端强制复核的最小能力。 */
export const GOVERNOR_REMOTE_CAPABILITIES = Object.freeze({
  describeAccess: 'governor.read',
  listModels: 'governor.read',
  updateModel: 'governor.manage',
  listUsers: 'governor.read',
  updateUser: 'governor.manage',
  getRouting: 'governor.read',
  updateRouting: 'governor.manage',
  queryUsage: 'governor.read',
  getSessionSelectionMode: 'governor.read',
  setSessionSelectionMode: 'governor.manage',
  explainDecision: 'governor.read',
  listAuditEntries: 'governor.audit',
} satisfies Record<string, GovernorCapability>);

/**
 * rc.8 的 Vitest 转换器不能解析 Stage-3 decorator 语法；这里用同一个公开
 * `Remote` decorator API 构造标准 initializer，运行语义与 `@Remote` 等价。
 */
const remoteInitializers: Array<(this: object) => void> = [];

function markRemoteMethod(prototype: object, method: string): void {
  const implementation = Reflect.get(prototype, method) as (...args: unknown[]) => unknown;
  const decorator = Remote as unknown as (
    value: (...args: unknown[]) => unknown,
    context: {
      name: string;
      private: false;
      static: false;
      addInitializer(initializer: (this: object) => void): void;
    },
  ) => void;
  decorator(implementation, {
    name: method,
    private: false,
    static: false,
    addInitializer(initializer) {
      remoteInitializers.push(initializer);
    },
  });
}

/** 浏览器可展示的 Usage DTO；BigInt 以十进制字符串跨越 JSON 边界。 */
export interface GovernorRemoteUsage {
  requestId: string;
  sessionId: string;
  userId: string;
  provider: string;
  model: string;
  routingMode: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  creditNanos: string;
  success: boolean;
  latencyMs: number;
  fallbackIndex: number;
  createdAt: string;
}

/** JSON 大小复核；Remote 无法以超大业务参数绕开 256 KiB 合同。 */
function assertRemotePayloadSize(value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > GOVERNOR_REMOTE_MAX_BYTES) {
    throw new TypertLookupFailure({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Governor Remote payload exceeds 256 KiB',
      details: { limit: GOVERNOR_REMOTE_MAX_BYTES },
    });
  }
}

/** 将权限拒绝映射为 Connection 可保留的稳定 RPC failure。 */
function remoteAuthorizationFailure(error: GovernorAuthorizationError): TypertLookupFailure {
  return new TypertLookupFailure({
    code: error.code,
    message: error.message,
    details: {},
  });
}

const SAFE_GOVERNOR_ERROR_CODES = new Set([
  'MODEL_NOT_FOUND',
  'USER_NOT_FOUND',
  'INVALID_MULTIPLIER',
  'INVALID_ROUTING_MODE',
  'INVALID_MINIMUM_QUALITY',
  'INVALID_ON_NO_MATCH',
  'INVALID_CONFIDENCE_THRESHOLD',
  'INVALID_QUALITY_THRESHOLDS',
  'INVALID_MAX_ATTEMPTS',
  'INVALID_FALLBACK_STRATEGY',
  'INVALID_REQUEST',
  'INVALID_MONTHLY_CREDITS',
  'INVALID_USER_ALLOW',
]);

/** RPC 只透出约定的稳定业务码；未知异常不泄漏内部消息。 */
function remoteBusinessFailure(error: unknown): TypertLookupFailure {
  if (error instanceof TypertLookupFailure) return error;
  if (error instanceof RoutingError) {
    return new TypertLookupFailure({ code: error.code, message: error.code, details: {} });
  }
  if (error instanceof Error && SAFE_GOVERNOR_ERROR_CODES.has(error.message)) {
    return new TypertLookupFailure({ code: error.message, message: error.message, details: {} });
  }
  return new TypertLookupFailure({
    code: 'INTERNAL_ERROR',
    message: 'Governor operation failed',
    details: {},
  });
}

/**
 * 真实 Host Remote Service。`typertRemote` binding 由 TypertRemoteService 创建，
 * namespace 固定为 `governor`；严格 descriptors 见 typert-host.ts。
 */
export class GovernorRemoteService extends TypertRemoteService {
  private readonly governor: GovernorService;
  private readonly resolvePrincipal: GovernorPrincipalResolver;

  constructor(
    ctx: Context,
    governor: GovernorService,
    resolvePrincipal: GovernorPrincipalResolver,
  ) {
    super(ctx, 'governorRemote', { namespace: 'governor' });
    this.governor = governor;
    this.resolvePrincipal = resolvePrincipal;
    for (const initializer of remoteInitializers) initializer.call(this);
  }

  /** Host 权限复核的唯一入口。 */
  private async authorize(capability: GovernorCapability, payload: unknown) {
    assertRemotePayloadSize(payload);
    try {
      return await requireGovernorCapability(this.resolvePrincipal, capability);
    } catch (error) {
      if (error instanceof GovernorAuthorizationError) throw remoteAuthorizationFailure(error);
      throw remoteBusinessFailure(error);
    }
  }

  /** 统一执行权限复核与业务错误封装，确保 dispatchRpc 不降级成 internal。 */
  private async execute<T>(
    capability: GovernorCapability,
    payload: unknown,
    operation: (principal: GovernorPrincipal) => T | Promise<T>,
  ): Promise<T> {
    const principal = await this.authorize(capability, payload);
    try {
      return await operation(principal);
    } catch (error) {
      throw remoteBusinessFailure(error);
    }
  }

  async describeAccess() {
    return this.execute(GOVERNOR_REMOTE_CAPABILITIES.describeAccess, {}, (principal) => ({
      actorId: principal.id,
      capabilities: [...principal.capabilities].sort(),
    }));
  }

  async listModels() {
    return this.execute(GOVERNOR_REMOTE_CAPABILITIES.listModels, {}, () =>
      this.governor.listModels(),
    );
  }

  async updateModel(
    routeId: string,
    patch: { enabled?: boolean; multiplier?: number },
    options?: { expectedRevision?: number },
  ) {
    return this.execute(
      GOVERNOR_REMOTE_CAPABILITIES.updateModel,
      { routeId, patch, options },
      (principal) =>
        this.governor.updateModel(routeId, patch, {
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
          actor: principal.id,
        }),
    );
  }

  async listUsers() {
    return this.execute(GOVERNOR_REMOTE_CAPABILITIES.listUsers, {}, () =>
      this.governor.listUsers(),
    );
  }

  async updateUser(
    userId: string,
    patch: { monthlyCredits?: number; allow?: string[] },
    options?: { expectedRevision?: number },
  ) {
    return this.execute(
      GOVERNOR_REMOTE_CAPABILITIES.updateUser,
      { userId, patch, options },
      (principal) =>
        this.governor.updateUser(userId, patch, {
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
          actor: principal.id,
        }),
    );
  }

  async getRouting() {
    return this.execute(GOVERNOR_REMOTE_CAPABILITIES.getRouting, {}, () =>
      this.governor.getRoutingSettings(),
    );
  }

  async updateRouting(
    patch: GovernorRoutingSettingsPatch,
    options?: { expectedRevision?: number },
  ) {
    return this.execute(
      GOVERNOR_REMOTE_CAPABILITIES.updateRouting,
      { patch, options },
      (principal) =>
        this.governor.updateRoutingSettings(patch, {
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
          actor: principal.id,
        }),
    );
  }

  async queryUsage(query: GovernorUsageQuery) {
    return this.execute(GOVERNOR_REMOTE_CAPABILITIES.queryUsage, { query }, async () => {
      const events = await this.governor.queryUsage(normalizeGovernorUsageQuery(query));
      return events.map((event): GovernorRemoteUsage => ({
        requestId: event.requestId,
        sessionId: event.sessionId,
        userId: event.userId,
        provider: event.provider,
        model: event.model,
        routingMode: event.routingMode,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        creditNanos: event.creditNanos.toString(),
        success: event.success,
        latencyMs: event.latencyMs,
        fallbackIndex: event.fallbackIndex,
        createdAt: event.createdAt,
      }));
    });
  }

  async getSessionSelectionMode(sessionId: string) {
    return this.execute(GOVERNOR_REMOTE_CAPABILITIES.getSessionSelectionMode, { sessionId }, () =>
      this.governor.getSessionSelectionMode(sessionId),
    );
  }

  async setSessionSelectionMode(
    sessionId: string,
    mode: 'auto' | 'manual',
    options?: { expectedRevision?: number; lastManualRoute?: string; currentRoute?: string },
  ) {
    return this.execute(
      GOVERNOR_REMOTE_CAPABILITIES.setSessionSelectionMode,
      { sessionId, mode, options },
      () => this.governor.setSessionSelectionMode(sessionId, mode, options),
    );
  }

  async explainDecision(requestId: string, fallbackIndex?: number) {
    return this.execute(
      GOVERNOR_REMOTE_CAPABILITIES.explainDecision,
      { requestId, fallbackIndex },
      () => this.governor.explainDecision(requestId, fallbackIndex),
    );
  }

  async listAuditEntries(limit: number) {
    return this.execute(GOVERNOR_REMOTE_CAPABILITIES.listAuditEntries, { limit }, () =>
      this.governor.listAuditEntries(Math.min(Math.max(limit, 1), 200)),
    );
  }
}

for (const method of Object.keys(GOVERNOR_REMOTE_CAPABILITIES)) {
  markRemoteMethod(GovernorRemoteService.prototype, method);
}
