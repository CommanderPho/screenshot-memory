declare module "bun:sqlite" {
  interface Statement {
    get(...params: unknown[]): Record<string, unknown> | null | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): unknown;
  }

  export class Database {
    constructor(filename: string);
    exec(sql: string): void;
    query(sql: string): Statement;
    close(): void;
  }
}

declare module "node:sqlite" {
  interface Statement {
    get(...params: unknown[]): Record<string, unknown> | null | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
