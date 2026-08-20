/**
 * SQLite 数据库管理：WAL 模式、迁移、owner-only 权限。
 * 使用 Node 内置 node:sqlite，无需原生依赖。
 * 迁移失败时 fail closed，不以空库继续。
 */
import { DatabaseSync } from 'node:sqlite';
/** Governor SQLite 数据库句柄。 */
export declare class GovernorDatabase {
    private readonly _db;
    /**
     * 打开数据库。启用 WAL，设置 owner-only 权限由调用方确保目录权限。
     * @param path - 数据库文件路径。
     */
    constructor(path: string);
    /** 运行未应用的迁移。失败时 fail closed。 */
    private _runMigrations;
    /** 执行 SQL（DDL）。 */
    exec(sql: string): void;
    /** 预编译语句。 */
    prepare(sql: string): ReturnType<DatabaseSync['prepare']>;
    /** 在事务中执行。 */
    transaction<T>(fn: () => T): T;
    /** 关闭数据库。 */
    close(): void;
}
