/**
 * Minimal ambient declaration for better-sqlite3.
 *
 * The package ships without official types; `@types/better-sqlite3` is an
 * extra devDep we don't want to add (keeping the refactor's dep surface
 * frozen at what Stage 2 already carried). Only the read-only surface the
 * cookie probe needs is declared — prepare / get / close.
 */

declare module 'better-sqlite3' {
    export interface Statement {
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    }

    export interface Database {
        prepare(sql: string): Statement;
        close(): void;
        pragma(source: string, options?: { simple?: boolean }): unknown;
    }

    export interface DatabaseOptions {
        readonly?: boolean;
        fileMustExist?: boolean;
        timeout?: number;
    }

    interface DatabaseConstructor {
        new (path: string, options?: DatabaseOptions): Database;
        (path: string, options?: DatabaseOptions): Database;
    }

    const Database: DatabaseConstructor;
    export default Database;
}
