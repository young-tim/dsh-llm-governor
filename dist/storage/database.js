/**
 * SQLite 数据库管理：WAL 模式、迁移、owner-only 权限。
 * 使用 Node 内置 node:sqlite，无需原生依赖。
 * 迁移失败时 fail closed，不以空库继续。
 */
import { DatabaseSync } from 'node:sqlite';
/** 全部迁移脚本。 */
const MIGRATIONS = [
    {
        version: 1,
        up: [
            `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
            `CREATE TABLE IF NOT EXISTS model_policies (
        route_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        multiplier_ppm INTEGER NOT NULL DEFAULT 1000000,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        quality_json TEXT NOT NULL DEFAULT '{}'
      )`,
            `CREATE TABLE IF NOT EXISTS user_policies (
        user_id TEXT PRIMARY KEY,
        monthly_credit_nanos INTEGER NOT NULL DEFAULT 0
      )`,
            `CREATE TABLE IF NOT EXISTS user_model_allow (
        user_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        PRIMARY KEY (user_id, route_id)
      )`,
            `CREATE TABLE IF NOT EXISTS session_identities (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        display_name TEXT,
        email TEXT,
        attributes_json TEXT,
        expires_at INTEGER,
        bound_at TEXT NOT NULL
      )`,
            `CREATE TABLE IF NOT EXISTS routing_decisions (
        request_id TEXT NOT NULL,
        fallback_index INTEGER NOT NULL,
        mode TEXT NOT NULL,
        task_type TEXT,
        complexity TEXT,
        confidence REAL,
        minimum_quality INTEGER,
        candidates_json TEXT NOT NULL,
        excluded_json TEXT NOT NULL,
        selected_route TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (request_id, fallback_index)
      )`,
            `CREATE TABLE IF NOT EXISTS usage_events (
        request_id TEXT NOT NULL,
        fallback_index INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        step INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        routing_mode TEXT NOT NULL,
        task_type TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        credit_nanos INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL,
        finish_kind TEXT,
        error_code TEXT,
        http_status INTEGER,
        latency_ms INTEGER NOT NULL,
        attempt_origin TEXT NOT NULL DEFAULT 'middleware_or_unknown',
        usage_missing INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (request_id, fallback_index)
      )`,
            `CREATE TABLE IF NOT EXISTS classifier_cache (
        input_hash TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        complexity TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (input_hash, config_revision)
      )`,
            `CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events (user_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_usage_route ON usage_events (provider, model, created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_usage_mode ON usage_events (routing_mode, created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_usage_request ON usage_events (request_id)`,
            `CREATE INDEX IF NOT EXISTS idx_decisions_request ON routing_decisions (request_id)`,
        ],
    },
    {
        // v2（GOV-DECISION/CONFIG/SEC/ATTEMPT）：统一 Decision 数据模型、配置
        // revision 权威、管理审计与 attempt 生命周期。重建 routing_decisions 前
        // 先备份旧表（GOV-STORAGE-001 AC 3），旧行的派生键回填、无法派生的
        // 新字段保持 NULL（查询层显示 unknown，不伪造值）。
        version: 2,
        up: [
            `ALTER TABLE routing_decisions RENAME TO routing_decisions_v1_backup`,
            `CREATE TABLE routing_decisions (
        decision_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        fallback_index INTEGER NOT NULL,
        session_id TEXT,
        turn INTEGER,
        step INTEGER,
        decision_hash TEXT,
        trigger TEXT,
        causes_json TEXT,
        changed_fields_json TEXT,
        selection_mode TEXT,
        effective_strategy TEXT,
        classifier_source TEXT,
        mode TEXT NOT NULL,
        task_type TEXT,
        complexity TEXT,
        confidence REAL,
        minimum_quality INTEGER,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        candidates_total_count INTEGER,
        candidates_truncated INTEGER NOT NULL DEFAULT 0,
        candidates_truncated_digest TEXT,
        excluded_json TEXT NOT NULL DEFAULT '[]',
        excluded_total_count INTEGER,
        excluded_truncated INTEGER NOT NULL DEFAULT 0,
        excluded_truncated_digest TEXT,
        selected_route TEXT,
        outcome TEXT,
        error_code TEXT,
        audit_state TEXT NOT NULL DEFAULT 'committed',
        config_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (request_id, fallback_index)
      )`,
            `INSERT INTO routing_decisions (
        decision_id, request_id, fallback_index, mode, task_type, complexity,
        confidence, minimum_quality, candidates_json, excluded_json,
        selected_route, outcome, audit_state, config_revision, created_at
      )
      SELECT
        request_id || ':' || fallback_index, request_id, fallback_index, mode,
        task_type, complexity, confidence, minimum_quality, candidates_json,
        excluded_json, selected_route, 'selected', 'committed', config_revision,
        created_at
      FROM routing_decisions_v1_backup`,
            `CREATE INDEX IF NOT EXISTS idx_decisions_request ON routing_decisions (request_id)`,
            `CREATE INDEX IF NOT EXISTS idx_decisions_session ON routing_decisions (session_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_decisions_created ON routing_decisions (created_at, decision_id)`,
            `CREATE INDEX IF NOT EXISTS idx_decisions_audit_state ON routing_decisions (audit_state)`,
            `CREATE TABLE IF NOT EXISTS governor_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
            `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        changed_fields_json TEXT,
        old_revision INTEGER,
        new_revision INTEGER,
        result TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL
      )`,
            `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, created_at)`,
            `CREATE TABLE IF NOT EXISTS attempt_states (
        request_id TEXT NOT NULL,
        fallback_index INTEGER NOT NULL,
        state TEXT NOT NULL,
        provider_request_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (request_id, fallback_index)
      )`,
            `CREATE INDEX IF NOT EXISTS idx_attempt_states_state ON attempt_states (state)`,
        ],
    },
    {
        // v3（GOV-USAGE-001）：Usage 增加 usage_kind（conversation/classifier）
        // 与 parent_request_id（分类器调用关联父请求）。
        version: 3,
        up: [
            `ALTER TABLE usage_events ADD COLUMN usage_kind TEXT NOT NULL DEFAULT 'conversation'`,
            `ALTER TABLE usage_events ADD COLUMN parent_request_id TEXT`,
            `CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage_events (usage_kind, created_at)`,
        ],
    },
];
/** Governor SQLite 数据库句柄。 */
export class GovernorDatabase {
    _db;
    /**
     * 打开数据库。启用 WAL，设置 owner-only 权限由调用方确保目录权限。
     * @param path - 数据库文件路径。
     */
    constructor(path) {
        this._db = new DatabaseSync(path);
        this._db.exec('PRAGMA journal_mode = WAL');
        this._db.exec('PRAGMA foreign_keys = ON');
        this._runMigrations();
    }
    /** 运行未应用的迁移。失败时 fail closed。 */
    _runMigrations() {
        this._db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
        const stmt = this._db.prepare('SELECT version FROM schema_migrations ORDER BY version');
        const rows = stmt.all();
        const applied = new Set(rows.map((r) => r.version));
        for (const migration of MIGRATIONS) {
            if (applied.has(migration.version))
                continue;
            this._db.exec('BEGIN TRANSACTION');
            try {
                for (const sql of migration.up) {
                    this._db.exec(sql);
                }
                this._db
                    .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
                    .run(migration.version, new Date().toISOString());
                this._db.exec('COMMIT');
            }
            catch (err) {
                this._db.exec('ROLLBACK');
                throw err;
            }
        }
    }
    /** 执行 SQL（DDL）。 */
    exec(sql) {
        this._db.exec(sql);
    }
    /** 预编译语句。 */
    prepare(sql) {
        return this._db.prepare(sql);
    }
    /** 在事务中执行。 */
    transaction(fn) {
        this._db.exec('BEGIN TRANSACTION');
        try {
            const result = fn();
            this._db.exec('COMMIT');
            return result;
        }
        catch (err) {
            this._db.exec('ROLLBACK');
            throw err;
        }
    }
    /** 关闭数据库。 */
    close() {
        this._db.close();
    }
}
