/**
 * Local SQLite backup of OCR text, keyed by absolute image path.
 * A content hash lets a renamed or moved file be recognized.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, resolvePath } from "../utils/index.js";

interface SqlStatement {
  get(...params: unknown[]): Record<string, unknown> | null | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): unknown;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
  loadExtension(file: string): void;
}

export interface OcrBackupWrite {
  path: string;
  contentHash: string | null;
  text: string;
  title?: string | null;
  mtimeMs: number;
  size: number;
  confidence?: number | null;
  method?: string | null;
  tags?: string[] | null;
  width?: number | null;
  height?: number | null;
}

export interface OcrBackupRecord {
  path: string;
  contentHash: string | null;
  text: string;
  title: string | null;
  mtimeMs: number;
  size: number;
  confidence: number | null;
  method: string | null;
  updatedAt: number;
}

export interface OcrBackupMatch extends OcrBackupRecord {
  matchedBy: "path" | "hash";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ocr_text (
  path TEXT PRIMARY KEY,
  content_hash TEXT,
  text TEXT NOT NULL,
  title TEXT,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  confidence REAL,
  method TEXT,
  updated_at INTEGER NOT NULL,
  tags TEXT,
  width INTEGER,
  height INTEGER,
  embedded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ocr_text_content_hash ON ocr_text(content_hash);
`;

const EXTRA_COLUMNS: Array<[string, string]> = [
  ["tags", "TEXT"],
  ["width", "INTEGER"],
  ["height", "INTEGER"],
  ["embedded_at", "INTEGER"],
];

/** SQLite index next to the configured memory path: screenshots.mv2 -> screenshots.ocr.sqlite */
export function ocrBackupPath(memoryPath: string): string {
  const resolved = resolvePath(memoryPath);
  const stem = basename(resolved).replace(/\.mv2$/i, "");
  return join(dirname(resolved), `${stem}.ocr.sqlite`);
}

export function hashImageBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashImageFile(filePath: string): string {
  return hashImageBytes(readFileSync(filePath));
}

export async function openSqlDatabase(filePath: string): Promise<SqlDatabase> {
  if (process.versions.bun) {
    const bunSqlite = await import("bun:sqlite");
    const db = new bunSqlite.Database(filePath);
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.query(sql),
      close: () => db.close(),
      loadExtension: (file) => loadSqliteExtension(db, file),
    };
  }

  const nodeSqlite = await import("node:sqlite");
  const db = new nodeSqlite.DatabaseSync(filePath);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
    loadExtension: (file) => loadSqliteExtension(db, file),
  };
}

function loadSqliteExtension(db: object, file: string): void {
  const loader = db as { loadExtension?: (path: string) => void };
  if (!loader.loadExtension) {
    throw new Error("This SQLite build cannot load extensions.");
  }
  loader.loadExtension(file);
}

export function ensureOcrSchema(db: SqlDatabase): void {
  db.exec(SCHEMA);
  const existing = new Set(
    db.prepare("PRAGMA table_info(ocr_text)").all().map((row) => asString(row.name) ?? "")
  );
  for (const [name, type] of EXTRA_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ocr_text ADD COLUMN ${name} ${type}`);
    }
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function rowToRecord(row: Record<string, unknown>): OcrBackupRecord {
  return {
    path: asString(row.path) ?? "",
    contentHash: asString(row.content_hash),
    text: asString(row.text) ?? "",
    title: asString(row.title),
    mtimeMs: asNumber(row.mtime_ms) ?? 0,
    size: asNumber(row.size) ?? 0,
    confidence: asNumber(row.confidence),
    method: asString(row.method),
    updatedAt: asNumber(row.updated_at) ?? 0,
  };
}

export class OcrBackup {
  private constructor(readonly db: SqlDatabase) {}

  /** Use a connection that already has the OCR schema. */
  static bind(db: SqlDatabase): OcrBackup {
    ensureOcrSchema(db);
    return new OcrBackup(db);
  }

  static async open(memoryPath: string): Promise<OcrBackup> {
    const filePath = ocrBackupPath(memoryPath);
    ensureDir(dirname(filePath));
    const db = await openSqlDatabase(filePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    return OcrBackup.bind(db);
  }

  close(): void {
    this.db.close();
  }

  /** Insert or replace the row for this path. Empty text is not stored. */
  upsert(write: OcrBackupWrite): void {
    const text = write.text.trim();
    if (!text) return;

    const path = resolvePath(write.path);
    this.db.prepare(
      `INSERT INTO ocr_text (
         path, content_hash, text, title, mtime_ms, size, confidence, method, updated_at,
         tags, width, height
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         content_hash = excluded.content_hash,
         text = excluded.text,
         title = excluded.title,
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         confidence = excluded.confidence,
         method = excluded.method,
         updated_at = excluded.updated_at,
         tags = excluded.tags,
         width = excluded.width,
         height = excluded.height,
         embedded_at = NULL`
    ).run(
      path,
      write.contentHash,
      text,
      write.title ?? null,
      write.mtimeMs,
      write.size,
      write.confidence ?? null,
      write.method ?? null,
      Date.now(),
      write.tags && write.tags.length > 0 ? JSON.stringify(write.tags) : null,
      write.width ?? null,
      write.height ?? null
    );
  }

  findByPath(filePath: string): OcrBackupRecord | null {
    const row = this.db.prepare(
      `SELECT path, content_hash, text, title, mtime_ms, size, confidence, method, updated_at
       FROM ocr_text WHERE path = ?`
    ).get(resolvePath(filePath));
    return row ? rowToRecord(row) : null;
  }

  /**
   * Path lookup first. Hash the file only when the path is missing.
   * If several rows share a hash, the most recently updated one wins.
   */
  findByPathOrHash(filePath: string, loadBytes: () => Uint8Array): OcrBackupMatch | null {
    const byPath = this.findByPath(filePath);
    if (byPath) {
      return { ...byPath, matchedBy: "path" };
    }

    const contentHash = hashImageBytes(loadBytes());
    const row = this.db.prepare(
      `SELECT path, content_hash, text, title, mtime_ms, size, confidence, method, updated_at
       FROM ocr_text
       WHERE content_hash = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    ).get(contentHash);
    if (!row) return null;
    return { ...rowToRecord(row), matchedBy: "hash" };
  }

  /**
   * When the catalog has never seen this path, reuse stored OCR text.
   * A hash hit also inserts a row for the new path and leaves the old row in place.
   */
  rememberMovedFile(
    filePath: string,
    stat: { mtimeMs: number; size: number }
  ): OcrBackupMatch | null {
    const match = this.findByPathOrHash(filePath, () => readFileSync(filePath));
    if (!match || !match.text.trim()) return null;

    if (match.matchedBy === "hash" && resolvePath(match.path) !== resolvePath(filePath)) {
      this.upsert({
        path: filePath,
        contentHash: match.contentHash,
        text: match.text,
        title: basename(filePath),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        confidence: match.confidence,
        method: match.method,
      });
    }

    return match;
  }

  isEmbedded(filePath: string): boolean {
    const row = this.db.prepare(
      "SELECT embedded_at FROM ocr_text WHERE path = ?"
    ).get(resolvePath(filePath));
    return asNumber(row?.embedded_at) !== null;
  }
}
