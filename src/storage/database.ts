/**
 * SQLite 数据库管理：WAL 模式、迁移、owner-only 权限。
 * 使用 Node 内置 node:sqlite，无需原生依赖。
 * 迁移失败时 fail closed，不以空库继续。
 */
import { DatabaseSync } from 'node:sqlite';

/** 迁移定义。 */
interface Migration {
  version: number;
  up: string[];
}

/** 全部迁移脚本。 */
const MIGRATIONS: Migration[] = [
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
];

/** Governor SQLite 数据库句柄。 */
export class GovernorDatabase {
  private readonly _db: DatabaseSync;

  /**
   * 打开数据库。启用 WAL，设置 owner-only 权限由调用方确保目录权限。
   * @param path - 数据库文件路径。
   */
  constructor(path: string) {
    this._db = new DatabaseSync(path);
    this._db.exec('PRAGMA journal_mode = WAL');
    this._db.exec('PRAGMA foreign_keys = ON');
    this._runMigrations();
  }

  /** 运行未应用的迁移。失败时 fail closed。 */
  private _runMigrations(): void {
    this._db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const stmt = this._db.prepare('SELECT version FROM schema_migrations ORDER BY version');
    const rows = stmt.all() as Array<{ version: number }>;
    const applied = new Set(rows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this._db.exec('BEGIN TRANSACTION');
      try {
        for (const sql of migration.up) {
          this._db.exec(sql);
        }
        this._db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
        this._db.exec('COMMIT');
      } catch (err) {
        this._db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** 执行 SQL（DDL）。 */
  exec(sql: string): void {
    this._db.exec(sql);
  }

  /** 预编译语句。 */
  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this._db.prepare(sql);
  }

  /** 在事务中执行。 */
  transaction<T>(fn: () => T): T {
    this._db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this._db.exec('COMMIT');
      return result;
    } catch (err) {
      this._db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 关闭数据库。 */
  close(): void {
    this._db.close();
  }
}
