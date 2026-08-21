/**
 * SQLite 数据仓库：模型策略、用户策略、白名单、身份绑定、决策、Usage、分类缓存的 CRUD。
 * Usage 和 Decision 的幂等通过主键保证；Decision 以 decisionId 为幂等键，
 * 同 ID 不同 hash 报 DECISION_CONFLICT（GOV-TRACE/DECISION）。
 */
import type { GovernorDatabase } from './database.js';
import type { TaskType, RoutingMode } from '../index.js';
import type { DecisionCandidate } from '../routing/types.js';
import type { SealedDecision } from '../routing/decision.js';

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
  usageKind?: 'conversation' | 'classifier';
  parentRequestId?: string;
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

/** 决策查询结果：v2 起的统一公开 Decision 视图（旧行缺失字段为 unknown，不伪造）。 */
export interface DecisionQueryResult {
  decisionId: string;
  decisionHash?: string;
  requestId: string;
  sessionId?: string;
  turn?: number;
  step?: number;
  fallbackIndex: number;
  trigger?: string;
  causes?: string[];
  changedFields?: string[];
  selectionMode?: 'manual' | 'auto';
  effectiveStrategy?: string;
  classifierSource?: string;
  mode: RoutingMode;
  taskType?: string;
  complexity?: string;
  confidence?: number;
  minimumQuality?: number;
  candidates: DecisionCandidate[];
  candidateTruncated: boolean;
  candidateTotalCount?: number;
  excluded: Array<{ routeId: string; reason: string }>;
  excludedTruncated: boolean;
  excludedTotalCount?: number;
  outcome: 'selected' | 'rejected';
  selectedRoute?: string;
  errorCode?: string;
  auditState: 'pending' | 'committed';
  configRevision: number;
  createdAt: string;
}

/** 管理审计条目（GOV-SEC-001）。 */
export interface AuditEntry {
  id?: number;
  actor: string;
  action: string;
  target: string;
  changedFields?: string[];
  oldRevision?: number;
  newRevision?: number;
  result: 'success' | 'denied' | 'error';
  errorCode?: string;
  createdAt: string;
}

/** attempt 生命周期状态（GOV-ATTEMPT-001）。 */
export type AttemptState =
  'not_dispatched' | 'dispatch_started' | 'completed' | 'failed' | 'cancelled' | 'indeterminate';

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

  // ===== 路由决策（幂等 + DECISION_CONFLICT + 审计状态） =====

  /** 插入不可变决策（audit_state=pending）。幂等：同 decisionId 同 hash 直接返回；不同 hash 抛 DECISION_CONFLICT。 */
  insertSealedDecision(
    decision: SealedDecision,
    context: { sessionId: string },
  ): 'inserted' | 'exists' {
    const existing = this._db
      .prepare('SELECT decision_hash, audit_state FROM routing_decisions WHERE decision_id = ?')
      .get(decision.decisionId) as
      { decision_hash: string | null; audit_state: string } | undefined;
    if (existing !== undefined) {
      // 旧行（v1 迁移）没有 hash：以重算 hash 判等（核心字段一致才允许幂等复用）。
      if (existing.decision_hash === null) {
        throw new Error(`DECISION_CONFLICT: ${decision.decisionId} exists without hash`);
      }
      if (existing.decision_hash !== decision.decisionHash) {
        throw new Error(`DECISION_CONFLICT: ${decision.decisionId}`);
      }
      return 'exists';
    }
    const stmt = this._db.prepare(
      `INSERT INTO routing_decisions
        (decision_id, request_id, fallback_index, session_id, turn, step, decision_hash,
         trigger, causes_json, changed_fields_json, selection_mode, effective_strategy,
         classifier_source, mode, task_type, complexity, confidence, minimum_quality,
         candidates_json, candidates_total_count, candidates_truncated, candidates_truncated_digest,
         excluded_json, excluded_total_count, excluded_truncated, excluded_truncated_digest,
         selected_route, outcome, error_code, audit_state, config_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    stmt.run(
      decision.decisionId,
      decision.requestId,
      decision.fallbackIndex,
      context.sessionId,
      decision.turn,
      decision.step,
      decision.decisionHash,
      decision.trigger,
      JSON.stringify(decision.causes),
      JSON.stringify(decision.changedFields),
      decision.selectionMode,
      decision.effectiveStrategy,
      decision.classifier?.source ?? null,
      this._modeOf(decision),
      decision.classifier?.taskType ?? null,
      decision.classifier?.complexity ?? null,
      decision.classifier?.confidence ?? null,
      decision.minimumQuality ?? null,
      JSON.stringify(decision.candidateTruncation.items),
      decision.candidateTruncation.totalCount,
      decision.candidateTruncation.truncated ? 1 : 0,
      decision.candidateTruncation.truncatedDigest ?? null,
      JSON.stringify(decision.excludedTruncation.items),
      decision.excludedTruncation.totalCount,
      decision.excludedTruncation.truncated ? 1 : 0,
      decision.excludedTruncation.truncatedDigest ?? null,
      decision.selectedRoute ?? null,
      decision.outcome,
      decision.errorCode ?? null,
      decision.configRevision,
      decision.createdAt,
    );
    return 'inserted';
  }

  /** 由 selectionMode/effectiveStrategy 推导 v1 兼容 mode 列。 */
  private _modeOf(decision: SealedDecision): RoutingMode {
    if (decision.selectionMode === 'manual') return 'manual';
    return decision.effectiveStrategy;
  }

  /** 以 decisionId/hash compare-and-set 将 audit_state 置为 committed；状态或 hash 不匹配返回 false。 */
  markDecisionCommitted(decisionId: string, expectedHash: string): boolean {
    const stmt = this._db.prepare(
      `UPDATE routing_decisions SET audit_state = 'committed'
       WHERE decision_id = ? AND decision_hash = ? AND audit_state = 'pending'`,
    );
    return stmt.run(decisionId, expectedHash).changes > 0;
  }

  /** 启动对账：列出全部 pending 决策（按创建时间升序）。 */
  listPendingDecisions(): DecisionQueryResult[] {
    const stmt = this._db.prepare(
      `SELECT * FROM routing_decisions WHERE audit_state = 'pending' ORDER BY created_at, decision_id`,
    );
    return (stmt.all() as Array<Record<string, unknown>>).map((r) => this._rowToDecision(r));
  }

  /** 按 requestId 精确查询完整 attempt 集合；指定 fallbackIndex 时只返回一个 attempt。 */
  getDecisions(requestId: string, fallbackIndex?: number): DecisionQueryResult[] {
    const sql =
      fallbackIndex !== undefined
        ? 'SELECT * FROM routing_decisions WHERE request_id = ? AND fallback_index = ?'
        : 'SELECT * FROM routing_decisions WHERE request_id = ? ORDER BY fallback_index';
    const stmt = this._db.prepare(sql);
    const rows =
      fallbackIndex !== undefined
        ? (stmt.all(requestId, fallbackIndex) as Array<Record<string, unknown>>)
        : (stmt.all(requestId) as Array<Record<string, unknown>>);
    return rows.map((r) => this._rowToDecision(r));
  }

  /** 将查询行映射为公开 Decision 视图（缺失字段不伪造）。 */
  private _rowToDecision(r: Record<string, unknown>): DecisionQueryResult {
    const optStr = (key: string): string | undefined => {
      const v = r[key];
      return typeof v === 'string' ? v : undefined;
    };
    const optNum = (key: string): number | undefined => {
      const v = r[key];
      return typeof v === 'number' ? v : undefined;
    };
    const sessionId = optStr('session_id');
    const turn = optNum('turn');
    const step = optNum('step');
    const trigger = optStr('trigger');
    const causesRaw = optStr('causes_json');
    const changedRaw = optStr('changed_fields_json');
    const selectionMode = optStr('selection_mode');
    const effectiveStrategy = optStr('effective_strategy');
    const classifierSource = optStr('classifier_source');
    const taskType = optStr('task_type');
    const complexity = optStr('complexity');
    const confidence = optNum('confidence');
    const minimumQuality = optNum('minimum_quality');
    const candidateTotalCount = optNum('candidates_total_count');
    const excludedTotalCount = optNum('excluded_total_count');
    const selectedRoute = optStr('selected_route');
    const errorCode = optStr('error_code');
    const decisionHash = optStr('decision_hash');
    return {
      decisionId: r['decision_id'] as string,
      ...(decisionHash != null ? { decisionHash } : {}),
      requestId: r['request_id'] as string,
      ...(sessionId != null ? { sessionId } : {}),
      ...(turn != null ? { turn } : {}),
      ...(step != null ? { step } : {}),
      fallbackIndex: r['fallback_index'] as number,
      ...(trigger != null ? { trigger } : {}),
      ...(causesRaw != null ? { causes: JSON.parse(causesRaw) as string[] } : {}),
      ...(changedRaw != null ? { changedFields: JSON.parse(changedRaw) as string[] } : {}),
      ...(selectionMode === 'manual' || selectionMode === 'auto' ? { selectionMode } : {}),
      ...(effectiveStrategy != null ? { effectiveStrategy } : {}),
      ...(classifierSource != null ? { classifierSource } : {}),
      mode: r['mode'] as RoutingMode,
      ...(taskType != null ? { taskType } : {}),
      ...(complexity != null ? { complexity } : {}),
      ...(confidence != null ? { confidence } : {}),
      ...(minimumQuality != null ? { minimumQuality } : {}),
      candidates: JSON.parse(r['candidates_json'] as string) as DecisionCandidate[],
      candidateTruncated: r['candidates_truncated'] === 1,
      ...(candidateTotalCount != null ? { candidateTotalCount } : {}),
      excluded: JSON.parse(r['excluded_json'] as string) as Array<{
        routeId: string;
        reason: string;
      }>,
      excludedTruncated: r['excluded_truncated'] === 1,
      ...(excludedTotalCount != null ? { excludedTotalCount } : {}),
      outcome: (r['outcome'] as 'selected' | 'rejected') ?? 'selected',
      ...(selectedRoute != null ? { selectedRoute } : {}),
      ...(errorCode != null ? { errorCode } : {}),
      auditState: r['audit_state'] as 'pending' | 'committed',
      configRevision: r['config_revision'] as number,
      createdAt: r['created_at'] as string,
    };
  }

  /** 列表分页查询：默认 50、最大 200、非精确查询最大时间范围 31 天。 */
  queryDecisions(opts: {
    sessionId?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: { createdAt: string; decisionId: string };
  }): { items: DecisionQueryResult[]; nextCursor?: { createdAt: string; decisionId: string } } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let sql = 'SELECT * FROM routing_decisions WHERE 1=1';
    const params: (string | number)[] = [];
    if (opts.sessionId !== undefined) {
      sql += ' AND session_id = ?';
      params.push(opts.sessionId);
    }
    if (opts.from !== undefined) {
      sql += ' AND created_at >= ?';
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      sql += ' AND created_at < ?';
      params.push(opts.to);
    }
    if (opts.cursor !== undefined) {
      sql += ' AND (created_at < ? OR (created_at = ? AND decision_id < ?))';
      params.push(opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.decisionId);
    }
    sql += ' ORDER BY created_at DESC, decision_id DESC LIMIT ?';
    params.push(limit + 1);
    const rows = this._db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((r) => this._rowToDecision(r));
    const last = page[page.length - 1];
    return {
      items,
      ...(hasMore && last != null
        ? {
            nextCursor: {
              createdAt: last['created_at'] as string,
              decisionId: last['decision_id'] as string,
            },
          }
        : {}),
    };
  }

  // ===== 配置 revision（GOV-CONFIG-001 权威） =====

  /** 读取全局单调递增 configRevision；未初始化返回 0（bootstrap 后为 1）。 */
  getConfigRevision(): number {
    const row = this._db
      .prepare("SELECT value FROM governor_kv WHERE key = 'config_revision'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /** 设置 configRevision（仅在配置事务内调用；与数据同事务提交）。 */
  setConfigRevision(revision: number): void {
    this._db
      .prepare(
        `INSERT INTO governor_kv (key, value) VALUES ('config_revision', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(String(revision));
  }

  /** 保存 bootstrap 来源信息（hash 与时间；重启不得覆盖管理写入）。 */
  setBootstrapSource(source: string): void {
    this._db
      .prepare(
        `INSERT INTO governor_kv (key, value) VALUES ('bootstrap_source', ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(source);
  }

  /** 读取 bootstrap 来源。 */
  getBootstrapSource(): string | undefined {
    const row = this._db
      .prepare("SELECT value FROM governor_kv WHERE key = 'bootstrap_source'")
      .get() as { value: string } | undefined;
    return row?.value;
  }

  // ===== 管理审计（GOV-SEC-001） =====

  /** 写入审计条目（配置事务失败时随事务回滚）。 */
  insertAuditEntry(entry: AuditEntry): void {
    this._db
      .prepare(
        `INSERT INTO audit_log
          (actor, action, target, changed_fields_json, old_revision, new_revision, result, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.actor,
        entry.action,
        entry.target,
        entry.changedFields ? JSON.stringify(entry.changedFields) : null,
        entry.oldRevision ?? null,
        entry.newRevision ?? null,
        entry.result,
        entry.errorCode ?? null,
        entry.createdAt,
      );
  }

  /** 查询审计条目（按时间倒序，分页）。 */
  listAuditEntries(limit: number): AuditEntry[] {
    const rows = this._db
      .prepare('SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r): AuditEntry => {
      const cf = r['changed_fields_json'] as string | null;
      const or = r['old_revision'] as number | null;
      const nr = r['new_revision'] as number | null;
      const ec = r['error_code'] as string | null;
      return {
        id: r['id'] as number,
        actor: r['actor'] as string,
        action: r['action'] as string,
        target: r['target'] as string,
        ...(cf != null ? { changedFields: JSON.parse(cf) as string[] } : {}),
        ...(or != null ? { oldRevision: or } : {}),
        ...(nr != null ? { newRevision: nr } : {}),
        result: r['result'] as 'success' | 'denied' | 'error',
        ...(ec != null ? { errorCode: ec } : {}),
        createdAt: r['created_at'] as string,
      };
    });
  }

  // ===== 分类器缓存（GOV-CLASSIFIER-001） =====

  /** 读取分类缓存（input_hash 为 HMAC 复合键哈希；TTL 由调用方检查）。 */
  getClassifierCache(
    inputHash: string,
    configRevision: number,
  ):
    | {
        taskType: string;
        complexity: string;
        confidence: number;
        source: string;
        createdAt: string;
      }
    | undefined {
    const row = this._db
      .prepare(
        'SELECT task_type, complexity, confidence, source, created_at FROM classifier_cache WHERE input_hash = ? AND config_revision = ?',
      )
      .get(inputHash, configRevision) as
      | {
          task_type: string;
          complexity: string;
          confidence: number;
          source: string;
          created_at: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      taskType: row.task_type,
      complexity: row.complexity,
      confidence: row.confidence,
      source: row.source,
      createdAt: row.created_at,
    };
  }

  /** 写入分类缓存（幂等 UPSERT）。 */
  setClassifierCache(
    inputHash: string,
    configRevision: number,
    entry: { taskType: string; complexity: string; confidence: number; source: string },
  ): void {
    this._db
      .prepare(
        `INSERT INTO classifier_cache (input_hash, config_revision, task_type, complexity, confidence, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(input_hash, config_revision) DO UPDATE SET
           task_type=excluded.task_type, complexity=excluded.complexity,
           confidence=excluded.confidence, source=excluded.source, created_at=excluded.created_at`,
      )
      .run(
        inputHash,
        configRevision,
        entry.taskType,
        entry.complexity,
        entry.confidence,
        entry.source,
        new Date().toISOString(),
      );
  }

  /** 读取 kv 值（HMAC key 等版本化合同数据）。 */
  getGovernorKv(key: string): string | undefined {
    const row = this._db.prepare('SELECT value FROM governor_kv WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  /** 写入 kv 值（已存在时不覆盖，幂等初始化）。 */
  setGovernorKvIfAbsent(key: string, value: string): void {
    this._db
      .prepare(`INSERT INTO governor_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
      .run(key, value);
  }

  // ===== attempt 生命周期（GOV-ATTEMPT-001） =====

  /** 幂等写入 attempt 状态（状态机收敛由调用方保证）。 */
  upsertAttemptState(
    requestId: string,
    fallbackIndex: number,
    state: AttemptState,
    providerRequestId?: string,
  ): void {
    this._db
      .prepare(
        `INSERT INTO attempt_states (request_id, fallback_index, state, provider_request_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(request_id, fallback_index) DO UPDATE SET
           state=excluded.state, provider_request_id=excluded.provider_request_id, updated_at=excluded.updated_at`,
      )
      .run(requestId, fallbackIndex, state, providerRequestId ?? null, new Date().toISOString());
  }

  /** 读取 attempt 状态。 */
  getAttemptState(requestId: string, fallbackIndex: number): AttemptState | undefined {
    const row = this._db
      .prepare('SELECT state FROM attempt_states WHERE request_id = ? AND fallback_index = ?')
      .get(requestId, fallbackIndex) as { state: AttemptState } | undefined;
    return row?.state;
  }

  // ===== Usage 事件（幂等） =====

  /** 插入 Usage 事件（幂等：重复 request_id+fallback_index 忽略）。 */
  insertUsageEvent(row: UsageEventRow): void {
    const stmt = this._db.prepare(
      `INSERT OR IGNORE INTO usage_events
        (request_id, fallback_index, session_id, usage_kind, parent_request_id, turn, step,
         user_id, provider, model, routing_mode, task_type, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, credit_nanos, success, finish_kind, error_code,
         http_status, latency_ms, attempt_origin, usage_missing, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      row.requestId,
      row.fallbackIndex,
      row.sessionId,
      row.usageKind ?? 'conversation',
      row.parentRequestId ?? null,
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
  queryUsage(opts: {
    userId?: string;
    provider?: string;
    usageKind?: 'conversation' | 'classifier';
    limit?: number;
  }): UsageEventRow[] {
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
    if (opts.usageKind !== undefined) {
      sql += ' AND usage_kind = ?';
      params.push(opts.usageKind);
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
      const uk = r['usage_kind'] as string | null;
      const pr = r['parent_request_id'] as string | null;
      return {
        requestId: r['request_id'] as string,
        fallbackIndex: r['fallback_index'] as number,
        sessionId: r['session_id'] as string,
        ...(uk === 'classifier' ? { usageKind: 'classifier' as const } : {}),
        ...(pr != null ? { parentRequestId: pr } : {}),
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

  /** GOV-USAGE-001 统计分母：Requests 以 requestId 去重，Attempts 以行数计。 */
  countUsageRequests(opts: { usageKind?: 'conversation' | 'classifier' } = {}): {
    requests: number;
    attempts: number;
  } {
    const sql =
      opts.usageKind !== undefined
        ? 'SELECT COUNT(DISTINCT request_id) AS requests, COUNT(*) AS attempts FROM usage_events WHERE usage_kind = ?'
        : 'SELECT COUNT(DISTINCT request_id) AS requests, COUNT(*) AS attempts FROM usage_events';
    const row = (
      opts.usageKind !== undefined
        ? this._db.prepare(sql).get(opts.usageKind)
        : this._db.prepare(sql).get()
    ) as { requests: number; attempts: number };
    return { requests: row.requests, attempts: row.attempts };
  }
}
