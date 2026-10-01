/**
 * Local search index: OCR text in SQLite, FTS5 for keywords, sqlite-vec for embeddings.
 */

import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { OLLAMA_EMBED_DIMENSION, OLLAMA_EMBED_MODEL } from "../embeddings/ollama.js";
import { ensureDir, logger } from "../utils/index.js";
import {
  OcrBackup,
  ensureOcrSchema,
  ocrBackupPath,
  openSqlDatabase,
  type SqlDatabase,
} from "./ocr-backup.js";

export const RRF_K = 60;

export interface VectorBatchItem {
  path: string;
  embedding: number[];
  tags?: string[];
  width?: number | null;
  height?: number | null;
}

export interface StoredHit {
  path: string;
  title: string;
  snippet: string;
  text: string;
  score: number;
  tags: string[];
  mtimeMs: number;
  size: number;
  width: number | null;
  height: number | null;
  confidence: number | null;
  matches: number;
}

export interface SearchStats {
  documentCount: number;
  indexSizeBytes: number;
  hasLexIndex: boolean;
  hasVecIndex: boolean;
  memoryPath: string;
}

const SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS ocr_fts USING fts5(
  text,
  title,
  tags,
  content='ocr_text',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_screenshots USING vec0(
  embedding float[${OLLAMA_EMBED_DIMENSION}] distance_metric=cosine
);
CREATE TRIGGER IF NOT EXISTS ocr_text_ai AFTER INSERT ON ocr_text BEGIN
  INSERT INTO ocr_fts(rowid, text, title, tags)
  VALUES (new.rowid, new.text, new.title, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS ocr_text_ad AFTER DELETE ON ocr_text BEGIN
  INSERT INTO ocr_fts(ocr_fts, rowid, text, title, tags)
  VALUES ('delete', old.rowid, old.text, old.title, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS ocr_text_au AFTER UPDATE ON ocr_text BEGIN
  INSERT INTO ocr_fts(ocr_fts, rowid, text, title, tags)
  VALUES ('delete', old.rowid, old.text, old.title, old.tags);
  INSERT INTO ocr_fts(rowid, text, title, tags)
  VALUES (new.rowid, new.text, new.title, new.tags);
END;
`;

/** Merge ranked id lists. Earlier positions contribute more. */
export function reciprocalRankFusion(rankedIds: string[][], k = RRF_K): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of rankedIds) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** Best hit scores 1. A single weak match still scores 1 so it is not dropped. */
export function normalizeScores<T extends { score: number }>(hits: T[]): T[] {
  const top = hits[0]?.score ?? 0;
  if (!(top > 0)) {
    return hits.map((hit) => ({ ...hit, score: hits.length > 0 ? 1 : 0 }));
  }
  return hits.map((hit) => ({ ...hit, score: hit.score / top }));
}

/** Quote each word so FTS5 does not treat punctuation as syntax. */
export function toFtsQuery(raw: string): string {
  const tokens = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" AND ");
}

export class SearchStore {
  private constructor(
    private readonly db: SqlDatabase,
    readonly texts: OcrBackup,
    readonly path: string
  ) {}

  static async open(memoryPath: string): Promise<SearchStore> {
    const filePath = ocrBackupPath(memoryPath);
    ensureDir(dirname(filePath));
    const db = await openSqlDatabase(filePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    try {
      const sqliteVec = await import("sqlite-vec");
      sqliteVec.load(db);
    } catch (err) {
      db.close();
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not load the local vector index (${detail}).`);
    }
    try {
      ensureOcrSchema(db);
      db.exec(SEARCH_SCHEMA);
    } catch (err) {
      db.close();
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not open the local search index (${detail}).`);
    }
    const store = new SearchStore(db, OcrBackup.bind(db), filePath);
    store.syncFts();
    store.assertEmbeddingIdentity();
    return store;
  }

  close(): void {
    this.db.close();
  }

  isEmbedded(filePath: string): boolean {
    return this.texts.isEmbedded(filePath);
  }

  /** Drop vectors so --force can embed the files again. OCR text stays. */
  clearVectors(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM vec_screenshots");
      this.db.exec("UPDATE ocr_text SET embedded_at = NULL");
    });
  }

  insertBatch(items: VectorBatchItem[]): void {
    if (items.length === 0) return;
    const rowForPath = this.db.prepare("SELECT rowid FROM ocr_text WHERE path = ?");
    const deleteVec = this.db.prepare("DELETE FROM vec_screenshots WHERE rowid = ?");
    const insertVec = this.db.prepare(
      "INSERT INTO vec_screenshots(rowid, embedding) VALUES (?, ?)"
    );
    const mark = this.db.prepare(
      `UPDATE ocr_text
       SET embedded_at = ?, tags = ?, width = ?, height = ?
       WHERE rowid = ?`
    );
    this.transaction(() => {
      for (const item of items) {
        if (item.embedding.length !== OLLAMA_EMBED_DIMENSION) {
          throw new Error(
            `Expected a ${OLLAMA_EMBED_DIMENSION}-d embedding for ${item.path}, got ${item.embedding.length}.`
          );
        }
        const row = rowForPath.get(item.path);
        const rowid = asNumber(row?.rowid);
        if (rowid === null) {
          throw new Error(`No stored text for ${item.path}.`);
        }
        deleteVec.run(rowid);
        insertVec.run(rowid, JSON.stringify(item.embedding));
        mark.run(
          Date.now(),
          item.tags && item.tags.length > 0 ? JSON.stringify(item.tags) : null,
          item.width ?? null,
          item.height ?? null,
          rowid
        );
      }
    });
  }

  searchLex(query: string, limit: number): StoredHit[] {
    const match = toFtsQuery(query);
    if (!match || limit < 1) return [];
    let rows: Record<string, unknown>[];
    try {
      rows = this.db.prepare(
        `SELECT
           ocr_text.path AS path,
           ocr_text.title AS title,
           ocr_text.text AS text,
           ocr_text.tags AS tags,
           ocr_text.mtime_ms AS mtime_ms,
           ocr_text.size AS size,
           ocr_text.width AS width,
           ocr_text.height AS height,
           ocr_text.confidence AS confidence,
           snippet(ocr_fts, 0, '', '', '...', 24) AS snippet,
           bm25(ocr_fts) AS bm25
         FROM ocr_fts
         JOIN ocr_text ON ocr_text.rowid = ocr_fts.rowid
         WHERE ocr_fts MATCH ?
         ORDER BY bm25
         LIMIT ?`
      ).all(match, limit);
    } catch (err) {
      logger.debug(`Lexical search failed: ${err}`);
      return [];
    }
    const hits = rows.map((row) => this.hitFromRow(row, -(asNumber(row.bm25) ?? 0)));
    return normalizeScores(hits);
  }

  searchSem(embedding: number[], limit: number): StoredHit[] {
    if (embedding.length !== OLLAMA_EMBED_DIMENSION || limit < 1) return [];
    let neighbors: Record<string, unknown>[];
    try {
      neighbors = this.db.prepare(
        `SELECT rowid, distance
         FROM vec_screenshots
         WHERE embedding MATCH ?
           AND k = ?`
      ).all(JSON.stringify(embedding), limit);
    } catch (err) {
      logger.debug(`Vector search failed: ${err}`);
      return [];
    }
    const hits: StoredHit[] = [];
    const byId = this.db.prepare(
      `SELECT path, title, text, tags, mtime_ms, size, width, height, confidence
       FROM ocr_text WHERE rowid = ?`
    );
    for (const neighbor of neighbors) {
      const rowid = asNumber(neighbor.rowid);
      if (rowid === null) continue;
      const row = byId.get(rowid);
      if (!row) continue;
      const distance = asNumber(neighbor.distance) ?? 1;
      const text = asString(row.text) ?? "";
      hits.push({
        ...this.hitFromRow(row, Math.max(0, 1 - distance)),
        snippet: text.slice(0, 240),
        text,
      });
    }
    return normalizeScores(hits);
  }

  searchHybrid(query: string, embedding: number[], limit: number): StoredHit[] {
    const lex = this.searchLex(query, limit);
    const sem = this.searchSem(embedding, limit);
    const fused = reciprocalRankFusion([
      lex.map((hit) => hit.path),
      sem.map((hit) => hit.path),
    ]);
    const byPath = new Map<string, StoredHit>();
    for (const hit of [...lex, ...sem]) {
      if (!byPath.has(hit.path)) byPath.set(hit.path, hit);
    }
    const hits = fused.flatMap((item) => {
      const hit = byPath.get(item.id);
      if (!hit) return [];
      const lexHit = lex.find((candidate) => candidate.path === item.id);
      return [{ ...hit, score: item.score, snippet: lexHit?.snippet || hit.snippet }];
    });
    return normalizeScores(hits);
  }

  textFor(filePath: string, maxChars: number): string {
    const row = this.texts.findByPath(filePath);
    if (!row) return "";
    return maxChars > 0 ? row.text.slice(0, maxChars) : row.text;
  }

  previews(paths: string[], full: boolean): Map<string, string> {
    const found = new Map<string, string>();
    const statement = this.db.prepare(
      full
        ? "SELECT path, text FROM ocr_text WHERE path = ?"
        : "SELECT path, substr(text, 1, 240) AS text FROM ocr_text WHERE path = ?"
    );
    for (const filePath of paths) {
      const row = statement.get(filePath);
      const text = asString(row?.text);
      if (text) found.set(filePath, text);
    }
    return found;
  }

  stats(): SearchStats {
    const documents = this.db.prepare("SELECT COUNT(*) AS n FROM ocr_text").get();
    const vectors = this.db.prepare("SELECT COUNT(*) AS n FROM vec_screenshots").get();
    return {
      documentCount: asNumber(documents?.n) ?? 0,
      indexSizeBytes: fileSize(this.path),
      hasLexIndex: true,
      hasVecIndex: (asNumber(vectors?.n) ?? 0) > 0,
      memoryPath: this.path,
    };
  }

  private syncFts(): void {
    // ocr_fts is an external-content table, so COUNT(*) reads ocr_text and
    // hides an empty keyword index. ocr_fts_docsize has one row per indexed document.
    const texts = this.db.prepare("SELECT COUNT(*) AS n FROM ocr_text").get();
    const indexed = this.db.prepare("SELECT COUNT(*) AS n FROM ocr_fts_docsize").get();
    if ((asNumber(texts?.n) ?? 0) !== (asNumber(indexed?.n) ?? 0)) {
      this.db.exec("INSERT INTO ocr_fts(ocr_fts) VALUES('rebuild')");
    }
  }

  private assertEmbeddingIdentity(): void {
    const model = this.meta("embedding_model");
    const dimension = this.meta("embedding_dimension");
    if (!model && !dimension) {
      this.setMeta("embedding_model", OLLAMA_EMBED_MODEL);
      this.setMeta("embedding_dimension", String(OLLAMA_EMBED_DIMENSION));
      return;
    }
    if (model !== OLLAMA_EMBED_MODEL || dimension !== String(OLLAMA_EMBED_DIMENSION)) {
      throw new Error(
        `This index uses ${model ?? "an unknown model"} (${dimension ?? "?"} dimensions). ` +
          `Run \`ssm index --force\` to rebuild it with ${OLLAMA_EMBED_MODEL}.`
      );
    }
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key);
    return asString(row?.value);
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO index_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The failed statement already rolled the transaction back.
      }
      throw err;
    }
  }

  private hitFromRow(row: Record<string, unknown>, score: number): StoredHit {
    const text = asString(row.text) ?? "";
    const tags = parseTags(row.tags);
    return {
      path: asString(row.path) ?? "",
      title: asString(row.title) ?? "",
      snippet: asString(row.snippet) ?? text.slice(0, 240),
      text,
      score,
      tags,
      mtimeMs: asNumber(row.mtime_ms) ?? 0,
      size: asNumber(row.size) ?? 0,
      width: asNumber(row.width),
      height: asNumber(row.height),
      confidence: asNumber(row.confidence),
      matches: 0,
    };
  }
}

function fileSize(path: string): number {
  let total = 0;
  for (const filePath of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(filePath)) continue;
    try {
      total += statSync(filePath).size;
    } catch {
      // A missing sidecar is not part of the index.
    }
  }
  return total;
}

function parseTags(value: unknown): string[] {
  const raw = asString(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}
