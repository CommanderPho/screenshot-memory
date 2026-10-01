/**
 * Local SQLite backup of OCR text, keyed by absolute image path.
 * A content hash lets a renamed or moved file be recognized.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, logger, resolvePath } from "../utils/index.js";

interface SqlStatement {
  get(...params: unknown[]): Record<string, unknown> | null | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): unknown;
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
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
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ocr_text_content_hash ON ocr_text(content_hash);
`;

/** SQLite file next to the memvid file: screenshots.mv2 -> screenshots.ocr.sqlite */
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

async function openSql(filePath: string): Promise<SqlDatabase> {
  if (process.versions.bun) {
    const bunSqlite = await import("bun:sqlite");
    const db = new bunSqlite.Database(filePath);
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.query(sql),
      close: () => db.close(),
    };
  }

  const nodeSqlite = await import("node:sqlite");
  const db = new nodeSqlite.DatabaseSync(filePath);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
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
  private constructor(private readonly db: SqlDatabase) {}

  static async open(memoryPath: string): Promise<OcrBackup> {
    const filePath = ocrBackupPath(memoryPath);
    ensureDir(dirname(filePath));
    const db = await openSql(filePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    return new OcrBackup(db);
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
         path, content_hash, text, title, mtime_ms, size, confidence, method, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         content_hash = excluded.content_hash,
         text = excluded.text,
         title = excluded.title,
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         confidence = excluded.confidence,
         method = excluded.method,
         updated_at = excluded.updated_at`
    ).run(
      path,
      write.contentHash,
      text,
      write.title ?? null,
      write.mtimeMs,
      write.size,
      write.confidence ?? null,
      write.method ?? null,
      Date.now()
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
}

interface MemoryTextSource {
  timeline(): Promise<Array<{ frame_id: number; uri?: string; preview?: string }>>;
  view(frameId: number): Promise<string>;
}

/**
 * Copy frames already stored in memvid into SQLite when that path is missing.
 * Hashes the image when the file is still on disk.
 */
export async function backfillOcrBackup(backup: OcrBackup, source: MemoryTextSource): Promise<number> {
  const timeline = await source.timeline();
  let inserted = 0;

  for (const entry of timeline) {
    if (!entry.uri) continue;
    const path = resolvePath(entry.uri);
    if (backup.findByPath(path)) continue;

    let text = "";
    try {
      text = await source.view(entry.frame_id);
    } catch (err) {
      logger.debug(`Could not read memvid frame ${entry.frame_id}: ${err}`);
      text = entry.preview ?? "";
    }
    if (!text.trim()) continue;

    let contentHash: string | null = null;
    let mtimeMs = 0;
    let size = 0;
    if (existsSync(path)) {
      try {
        const fileStat = statSync(path);
        contentHash = hashImageFile(path);
        mtimeMs = fileStat.mtime.getTime();
        size = fileStat.size;
      } catch (err) {
        logger.debug(`Could not hash ${path} during OCR backup backfill: ${err}`);
      }
    }

    backup.upsert({
      path,
      contentHash,
      text,
      title: basename(path),
      mtimeMs,
      size,
      method: "ocr",
    });
    inserted++;
  }

  logger.debug(`OCR backup backfill stored ${inserted} documents`);
  return inserted;
}

/** Read an existing `.mv2` once, then drop the handle before a later create. */
export async function backfillOcrBackupFile(backup: OcrBackup, memoryPath: string): Promise<number> {
  const resolvedMemory = resolvePath(memoryPath);
  if (!existsSync(resolvedMemory)) return 0;

  const { open } = await import("@memvid/sdk");
  const mv = await open(resolvedMemory, "basic", { readOnly: true });
  try {
    return await backfillOcrBackup(backup, mv);
  } finally {
    const core = (mv as unknown as { core?: { close?: () => void } }).core;
    if (typeof core?.close === "function") {
      core.close();
    }
  }
}
