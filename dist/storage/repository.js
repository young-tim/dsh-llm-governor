/**
 * Governor 数据仓库。封装所有 SQLite CRUD 操作。
 */
export class GovernorRepository {
    _db;
    constructor(db) {
        this._db = db;
    }
    // ===== 模型策略 =====
    /** 插入或更新模型策略。 */
    upsertModelPolicy(row) {
        const stmt = this._db.prepare(`INSERT INTO model_policies (route_id, provider, model, enabled, multiplier_ppm, capabilities_json, quality_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route_id) DO UPDATE SET
         provider=excluded.provider, model=excluded.model, enabled=excluded.enabled,
         multiplier_ppm=excluded.multiplier_ppm, capabilities_json=excluded.capabilities_json,
         quality_json=excluded.quality_json`);
        stmt.run(row.routeId, row.provider, row.model, row.enabled ? 1 : 0, row.multiplierPpm, JSON.stringify(row.capabilities), JSON.stringify(row.quality));
    }
    /** 获取全部模型策略。 */
    listModelPolicies() {
        const stmt = this._db.prepare('SELECT * FROM model_policies ORDER BY route_id');
        const rows = stmt.all();
        return rows.map((r) => ({
            routeId: r['route_id'],
            provider: r['provider'],
            model: r['model'],
            enabled: r['enabled'] === 1,
            multiplierPpm: r['multiplier_ppm'],
            capabilities: JSON.parse(r['capabilities_json']),
            quality: JSON.parse(r['quality_json']),
        }));
    }
    /** 删除模型策略。 */
    deleteModelPolicy(routeId) {
        const stmt = this._db.prepare('DELETE FROM model_policies WHERE route_id = ?');
        stmt.run(routeId);
    }
    // ===== 用户策略 =====
    /** 插入或更新用户策略。 */
    upsertUserPolicy(userId, monthlyCreditNanos) {
        const stmt = this._db.prepare('INSERT INTO user_policies (user_id, monthly_credit_nanos) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_credit_nanos=excluded.monthly_credit_nanos');
        stmt.run(userId, Number(monthlyCreditNanos));
    }
    /** 获取用户额度。 */
    getUserQuota(userId) {
        const stmt = this._db.prepare('SELECT monthly_credit_nanos FROM user_policies WHERE user_id = ?');
        const row = stmt.get(userId);
        return row?.monthly_credit_nanos !== undefined ? BigInt(row.monthly_credit_nanos) : undefined;
    }
    /** 获取全部用户 ID（按字典序）。 */
    listUserIds() {
        const stmt = this._db.prepare('SELECT user_id FROM user_policies ORDER BY user_id');
        const rows = stmt.all();
        return rows.map((r) => r.user_id);
    }
    // ===== 用户白名单 =====
    /** 添加用户允许的 route。 */
    addUserAllow(userId, routeId) {
        const stmt = this._db.prepare('INSERT OR IGNORE INTO user_model_allow (user_id, route_id) VALUES (?, ?)');
        stmt.run(userId, routeId);
    }
    /** 获取用户允许的 route 列表。 */
    listUserAllow(userId) {
        const stmt = this._db.prepare('SELECT route_id FROM user_model_allow WHERE user_id = ? ORDER BY route_id');
        const rows = stmt.all(userId);
        return rows.map((r) => r.route_id);
    }
    // ===== 身份绑定 =====
    /** 绑定 session 身份。 */
    upsertSessionIdentity(sessionId, userId, source, expiresAt, displayName, email, attributes) {
        const stmt = this._db.prepare(`INSERT INTO session_identities (session_id, user_id, source, display_name, email, attributes_json, expires_at, bound_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id=excluded.user_id, source=excluded.source, display_name=excluded.display_name,
         email=excluded.email, attributes_json=excluded.attributes_json, expires_at=excluded.expires_at, bound_at=excluded.bound_at`);
        stmt.run(sessionId, userId, source, displayName ?? null, email ?? null, attributes ? JSON.stringify(attributes) : null, expiresAt ?? null, new Date().toISOString());
    }
    /** 获取 session 身份。 */
    getSessionIdentity(sessionId) {
        const stmt = this._db.prepare('SELECT user_id, source, expires_at FROM session_identities WHERE session_id = ?');
        const row = stmt.get(sessionId);
        if (!row)
            return undefined;
        const result = {
            userId: row.user_id,
            source: row.source,
        };
        if (row.expires_at != null)
            result.expiresAt = row.expires_at;
        return result;
    }
    // ===== 路由决策（幂等） =====
    /** 插入决策记录（幂等：重复 request_id+fallback_index 忽略）。 */
    insertDecision(decision) {
        const stmt = this._db.prepare(`INSERT OR IGNORE INTO routing_decisions
        (request_id, fallback_index, mode, task_type, complexity, confidence, minimum_quality,
         candidates_json, excluded_json, selected_route, config_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run(decision.requestId, decision.fallbackIndex, decision.mode, decision.taskType ?? null, decision.complexity ?? null, decision.confidence ?? null, decision.minimumQuality ?? null, JSON.stringify(decision.candidates), JSON.stringify(decision.excluded), decision.selected, decision.configRevision, decision.createdAt);
    }
    /** 按 request_id 查询决策。 */
    getDecisions(requestId) {
        const stmt = this._db.prepare('SELECT * FROM routing_decisions WHERE request_id = ? ORDER BY fallback_index');
        const rows = stmt.all(requestId);
        return rows.map((r) => {
            const tt = r['task_type'];
            const cx = r['complexity'];
            const cf = r['confidence'];
            const mq = r['minimum_quality'];
            return {
                requestId: r['request_id'],
                fallbackIndex: r['fallback_index'],
                mode: r['mode'],
                ...(tt != null ? { taskType: tt } : {}),
                ...(cx != null ? { complexity: cx } : {}),
                ...(cf != null ? { confidence: cf } : {}),
                ...(mq != null ? { minimumQuality: mq } : {}),
                candidates: JSON.parse(r['candidates_json']),
                excluded: JSON.parse(r['excluded_json']),
                selected: r['selected_route'],
                configRevision: r['config_revision'],
                createdAt: r['created_at'],
            };
        });
    }
    // ===== Usage 事件（幂等） =====
    /** 插入 Usage 事件（幂等：重复 request_id+fallback_index 忽略）。 */
    insertUsageEvent(row) {
        const stmt = this._db.prepare(`INSERT OR IGNORE INTO usage_events
        (request_id, fallback_index, session_id, turn, step, user_id, provider, model,
         routing_mode, task_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         credit_nanos, success, finish_kind, error_code, http_status, latency_ms,
         attempt_origin, usage_missing, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run(row.requestId, row.fallbackIndex, row.sessionId, row.turn, row.step, row.userId, row.provider, row.model, row.routingMode, row.taskType ?? null, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, Number(row.creditNanos), row.success ? 1 : 0, row.finishKind ?? null, row.errorCode ?? null, row.httpStatus ?? null, row.latencyMs, row.attemptOrigin, row.usageMissing ? 1 : 0, row.createdAt);
    }
    /** 查询用户在指定时间范围内的已提交 Credits（bigint 求和）。 */
    sumUserCredits(userId, startTime, endTime) {
        const stmt = this._db.prepare(`SELECT COALESCE(SUM(credit_nanos), 0) AS total FROM usage_events
       WHERE user_id = ? AND created_at >= ? AND created_at < ? AND success = 1`);
        const row = stmt.get(userId, startTime, endTime);
        return BigInt(row.total ?? 0);
    }
    /** 查询 Usage 事件。 */
    queryUsage(opts) {
        let sql = 'SELECT * FROM usage_events WHERE 1=1';
        const params = [];
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
        const rows = stmt.all(...params);
        return rows.map((r) => {
            const tt = r['task_type'];
            const fk = r['finish_kind'];
            const ec = r['error_code'];
            const hs = r['http_status'];
            return {
                requestId: r['request_id'],
                fallbackIndex: r['fallback_index'],
                sessionId: r['session_id'],
                turn: r['turn'],
                step: r['step'],
                userId: r['user_id'],
                provider: r['provider'],
                model: r['model'],
                routingMode: r['routing_mode'],
                ...(tt != null ? { taskType: tt } : {}),
                inputTokens: r['input_tokens'],
                outputTokens: r['output_tokens'],
                cacheReadTokens: r['cache_read_tokens'],
                cacheWriteTokens: r['cache_write_tokens'],
                creditNanos: BigInt(r['credit_nanos']),
                success: r['success'] === 1,
                ...(fk != null ? { finishKind: fk } : {}),
                ...(ec != null ? { errorCode: ec } : {}),
                ...(hs != null ? { httpStatus: hs } : {}),
                latencyMs: r['latency_ms'],
                attemptOrigin: r['attempt_origin'],
                usageMissing: r['usage_missing'] === 1,
                createdAt: r['created_at'],
            };
        });
    }
}
