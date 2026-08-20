/**
 * SQLite 数据仓库：模型策略、用户策略、白名单、身份绑定、决策、Usage、分类缓存的 CRUD。
 * Usage 和 Decision 的幂等通过 PRIMARY KEY (request_id, fallback_index) 保证。
 */
import type { GovernorDatabase } from './database.js';
import type { TaskType, RoutingMode, Complexity } from '../index.js';
import type { DecisionRecord } from '../routing/types.js';

/** 模型策略行。 */
export interface ModelPolicyRow {
  routeId: string;
  provider: string;
  model: string;
  enabled: boolean;
  multiplierPpm: number;
  capabilities: string[];
  quality: Partial<Record<TaskType, number>>;
}

/** Usage 事件行。 */
export interface UsageEventRow {
  requestId: string;
  fallbackIndex: number;
  sessionId: string;
  turn: number;
  step: number;
  userId: string;
  provider: string;
  model: string;
  routingMode: RoutingMode;
  taskType?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  creditNanos: bigint;
  success: boolean;
  finishKind?: string;
  errorCode?: string;
  httpStatus?: number;
  latencyMs: number;
  attemptOrigin: 'provider' | 'middleware_or_unknown';
  usageMissing: boolean;
  createdAt: string;
}

/**
 * Governor 数据仓库。封装所有 SQLite CRUD 操作。
 */
export class GovernorRepository {
  private readonly _db: GovernorDatabase;

  constructor(db: GovernorDatabase) {
    this._db = db;
  }

  // ===== 模型策略 =====

  /** 插入或更新模型策略。 */
  upsertModelPolicy(row: ModelPolicyRow): void {
    const stmt = this._db.prepare(
      `INSERT INTO model_policies (route_id, provider, model, enabled, multiplier_ppm, capabilities_json, quality_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route_id) DO UPDATE SET
         provider=excluded.provider, model=excluded.model, enabled=excluded.enabled,
         multiplier_ppm=excluded.multiplier_ppm, capabilities_json=excluded.capabilities_json,
         quality_json=excluded.quality_json`,
    );
    stmt.run(
      row.routeId,
      row.provider,
      row.model,
      row.enabled ? 1 : 0,
      row.multiplierPpm,
      JSON.stringify(row.capabilities),
      JSON.stringify(row.quality),
    );
  }

  /** 获取全部模型策略。 */
  listModelPolicies(): ModelPolicyRow[] {
    const stmt = this._db.prepare('SELECT * FROM model_policies ORDER BY route_id');
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      routeId: r['route_id'] as string,
      provider: r['provider'] as string,
      model: r['model'] as string,
      enabled: r['enabled'] === 1,
      multiplierPpm: r['multiplier_ppm'] as number,
      capabilities: JSON.parse(r['capabilities_json'] as string) as string[],
      quality: JSON.parse(r['quality_json'] as string) as Partial<Record<TaskType, number>>,
    }));
  }

  /** 删除模型策略。 */
  deleteModelPolicy(routeId: string): void {
    const stmt = this._db.prepare('DELETE FROM model_policies WHERE route_id = ?');
    stmt.run(routeId);
  }

  // ===== 用户策略 =====

  /** 插入或更新用户策略。 */
  upsertUserPolicy(userId: string, monthlyCreditNanos: bigint): void {
    const stmt = this._db.prepare(
      'INSERT INTO user_policies (user_id, monthly_credit_nanos) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_credit_nanos=excluded.monthly_credit_nanos',
    );
    stmt.run(userId, Number(monthlyCreditNanos));
  }

  /** 获取用户额度。 */
  getUserQuota(userId: string): bigint | undefined {
    const stmt = this._db.prepare(
      'SELECT monthly_credit_nanos FROM user_policies WHERE user_id = ?',
    );
    const row = stmt.get(userId) as { monthly_credit_nanos?: number } | undefined;
    return row?.monthly_credit_nanos !== undefined ? BigInt(row.monthly_credit_nanos) : undefined;
  }

  /** 获取全部用户 ID（按字典序）。 */
  listUserIds(): string[] {
    const stmt = this._db.prepare('SELECT user_id FROM user_policies ORDER BY user_id');
    const rows = stmt.all() as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  // ===== 用户白名单 =====

  /** 添加用户允许的 route。 */
  addUserAllow(userId: string, routeId: string): void {
    const stmt = this._db.prepare(
      'INSERT OR IGNORE INTO user_model_allow (user_id, route_id) VALUES (?, ?)',
    );
    stmt.run(userId, routeId);
  }

  /** 获取用户允许的 route 列表。 */
  listUserAllow(userId: string): string[] {
    const stmt = this._db.prepare(
      'SELECT route_id FROM user_model_allow WHERE user_id = ? ORDER BY route_id',
    );
    const rows = stmt.all(userId) as Array<{ route_id: string }>;
    return rows.map((r) => r.route_id);
  }

  // ===== 身份绑定 =====

  /** 绑定 session 身份。 */
  upsertSessionIdentity(
    sessionId: string,
    userId: string,
    source: string,
    expiresAt?: number,
    displayName?: string,
    email?: string,
    attributes?: Record<string, unknown>,
  ): void {
    const stmt = this._db.prepare(
      `INSERT INTO session_identities (session_id, user_id, source, display_name, email, attributes_json, expires_at, bound_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id=excluded.user_id, source=excluded.source, display_name=excluded.display_name,
         email=excluded.email, attributes_json=excluded.attributes_json, expires_at=excluded.expires_at, bound_at=excluded.bound_at`,
    );
    stmt.run(
      sessionId,
      userId,
      source,
      displayName ?? null,
      email ?? null,
      attributes ? JSON.stringify(attributes) : null,
      expiresAt ?? null,
      new Date().toISOString(),
    );
  }

  /** 获取 session 身份。 */
  getSessionIdentity(
    sessionId: string,
  ): { userId: string; source: string; expiresAt?: number } | undefined {
    const stmt = this._db.prepare(
      'SELECT user_id, source, expires_at FROM session_identities WHERE session_id = ?',
    );
    const row = stmt.get(sessionId) as
      { user_id: string; source: string; expires_at?: number | null } | undefined;
    if (!row) return undefined;
    const result: { userId: string; source: string; expiresAt?: number } = {
      userId: row.user_id,
      source: row.source,
    };
    if (row.expires_at != null) result.expiresAt = row.expires_at;
    return result;
  }

  // ===== 路由决策（幂等） =====

  /** 插入决策记录（幂等：重复 request_id+fallback_index 忽略）。 */
  insertDecision(decision: DecisionRecord): void {
    const stmt = this._db.prepare(
      `INSERT OR IGNORE INTO routing_decisions
        (request_id, fallback_index, mode, task_type, complexity, confidence, minimum_quality,
         candidates_json, excluded_json, selected_route, config_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      decision.requestId,
      decision.fallbackIndex,
      decision.mode,
      decision.taskType ?? null,
      decision.complexity ?? null,
      decision.confidence ?? null,
      decision.minimumQuality ?? null,
      JSON.stringify(decision.candidates),
      JSON.stringify(decision.excluded),
      decision.selected,
      decision.configRevision,
      decision.createdAt,
    );
  }

  /** 按 request_id 查询决策。 */
  getDecisions(requestId: string): DecisionRecord[] {
    const stmt = this._db.prepare(
      'SELECT * FROM routing_decisions WHERE request_id = ? ORDER BY fallback_index',
    );
    const rows = stmt.all(requestId) as Array<Record<string, unknown>>;
    return rows.map((r): DecisionRecord => {
      const tt = r['task_type'] as string | null;
      const cx = r['complexity'] as string | null;
      const cf = r['confidence'] as number | null;
      const mq = r['minimum_quality'] as number | null;
      return {
        requestId: r['request_id'] as string,
        fallbackIndex: r['fallback_index'] as number,
        mode: r['mode'] as RoutingMode,
        ...(tt != null ? { taskType: tt as TaskType } : {}),
        ...(cx != null ? { complexity: cx as Complexity } : {}),
        ...(cf != null ? { confidence: cf } : {}),
        ...(mq != null ? { minimumQuality: mq } : {}),
        candidates: JSON.parse(r['candidates_json'] as string),
        excluded: JSON.parse(r['excluded_json'] as string),
        selected: r['selected_route'] as string,
        configRevision: r['config_revision'] as number,
        createdAt: r['created_at'] as string,
      };
    });
  }

  // ===== Usage 事件（幂等） =====

  /** 插入 Usage 事件（幂等：重复 request_id+fallback_index 忽略）。 */
  insertUsageEvent(row: UsageEventRow): void {
    const stmt = this._db.prepare(
      `INSERT OR IGNORE INTO usage_events
        (request_id, fallback_index, session_id, turn, step, user_id, provider, model,
         routing_mode, task_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         credit_nanos, success, finish_kind, error_code, http_status, latency_ms,
         attempt_origin, usage_missing, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      row.requestId,
      row.fallbackIndex,
      row.sessionId,
      row.turn,
      row.step,
      row.userId,
      row.provider,
      row.model,
      row.routingMode,
      row.taskType ?? null,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      Number(row.creditNanos),
      row.success ? 1 : 0,
      row.finishKind ?? null,
      row.errorCode ?? null,
      row.httpStatus ?? null,
      row.latencyMs,
      row.attemptOrigin,
      row.usageMissing ? 1 : 0,
      row.createdAt,
    );
  }

  /** 查询用户在指定时间范围内的已提交 Credits（bigint 求和）。 */
  sumUserCredits(userId: string, startTime: string, endTime: string): bigint {
    const stmt = this._db.prepare(
      `SELECT COALESCE(SUM(credit_nanos), 0) AS total FROM usage_events
       WHERE user_id = ? AND created_at >= ? AND created_at < ? AND success = 1`,
    );
    const row = stmt.get(userId, startTime, endTime) as { total: number | null };
    return BigInt(row.total ?? 0);
  }

  /** 查询 Usage 事件。 */
  queryUsage(opts: { userId?: string; provider?: string; limit?: number }): UsageEventRow[] {
    let sql = 'SELECT * FROM usage_events WHERE 1=1';
    const params: (string | number)[] = [];
    if (opts.userId) {
      sql += ' AND user_id = ?';
      params.push(opts.userId);
    }
    if (opts.provider) {
      sql += ' AND provider = ?';
      params.push(opts.provider);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(opts.limit ?? 100);
    const stmt = this._db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    return rows.map((r): UsageEventRow => {
      const tt = r['task_type'] as string | null;
      const fk = r['finish_kind'] as string | null;
      const ec = r['error_code'] as string | null;
      const hs = r['http_status'] as number | null;
      return {
        requestId: r['request_id'] as string,
        fallbackIndex: r['fallback_index'] as number,
        sessionId: r['session_id'] as string,
        turn: r['turn'] as number,
        step: r['step'] as number,
        userId: r['user_id'] as string,
        provider: r['provider'] as string,
        model: r['model'] as string,
        routingMode: r['routing_mode'] as RoutingMode,
        ...(tt != null ? { taskType: tt } : {}),
        inputTokens: r['input_tokens'] as number,
        outputTokens: r['output_tokens'] as number,
        cacheReadTokens: r['cache_read_tokens'] as number,
        cacheWriteTokens: r['cache_write_tokens'] as number,
        creditNanos: BigInt(r['credit_nanos'] as number),
        success: r['success'] === 1,
        ...(fk != null ? { finishKind: fk } : {}),
        ...(ec != null ? { errorCode: ec } : {}),
        ...(hs != null ? { httpStatus: hs } : {}),
        latencyMs: r['latency_ms'] as number,
        attemptOrigin: r['attempt_origin'] as 'provider' | 'middleware_or_unknown',
        usageMissing: r['usage_missing'] === 1,
        createdAt: r['created_at'] as string,
      };
    });
  }
}
