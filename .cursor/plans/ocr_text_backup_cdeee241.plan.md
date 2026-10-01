---
name: OCR text backup
overview: Write each screenshot’s OCR text into a local SQLite file keyed by absolute path, with a content hash so a moved file can be recognized. Memvid stays the search index.
todos:
  - id: config-flag
    content: Add indexing.ocrBackup to config, default true, and skip all SQLite work when false
    status: completed
  - id: ocr-backup-module
    content: "Add src/core/ocr-backup.ts: SQLite open, upsert by path, lookup by path then content hash"
    status: completed
  - id: indexer-write
    content: Hash image bytes on write; upsert OCR text before putDocuments; on path miss, reuse text when the hash matches
    status: completed
  - id: backfill
    content: On index, copy existing memvid frames into SQLite and hash the file when it is still at that path
    status: completed
  - id: test
    content: Bun test for path lookup, hash fallback, and a renamed path reusing the same text
    status: completed
isProject: false
---

# Local OCR text backup

Memvid stays the search index. OCR text is also upserted into a local SQLite file with no size cap, primary key = normalized absolute image path. Each row also stores a SHA-256 of the image bytes so a rename or move can be recognized. Nothing in this store is uploaded.

## Config

Add `ocrBackup: true` to `DEFAULT_CONFIG.indexing` in [src/utils/constants.ts](src/utils/constants.ts), and thread it through `IndexingConfig`, the Conf schema, and the `indexing` merge in [src/utils/config.ts](src/utils/config.ts). Default is on. Set `indexing.ocrBackup` to `false` in the config file to disable it.

When it is false, `indexDirectory` and `indexSingleImage` do not open SQLite, hash files for the backup, reuse stored text, or backfill from memvid. An existing `screenshots.ocr.sqlite` is left on disk.

## Store

New module [src/core/ocr-backup.ts](src/core/ocr-backup.ts). Database file sits next to the memvid file: `screenshots.mv2` becomes `screenshots.ocr.sqlite` (same directory from [src/utils/paths.ts](src/utils/paths.ts)).

Open it with Bun’s built-in `bun:sqlite` (the CLI runs under Bun). If the process is Node, use `node:sqlite`. WAL mode, one connection.

```sql
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
```

`content_hash` is SHA-256 of the file bytes (`node:crypto`), hex. It is nullable only when a backfill cannot read the file anymore.

`upsert(path, text, metadata)` replaces the row for that path and stores the hash. Lookup is `findByPathOrHash(path, fileBytes)`:

1. `SELECT` by primary key (the absolute path). This is the fast path and does not hash the file.
2. On a miss, hash the bytes and `SELECT` by `content_hash`. Hashing the file is the slow part; the index makes the query itself a lookup. If several rows share a hash, use the most recently updated one.

A hash hit on a new path inserts a row for that path with the same text and hash. The old path row stays, so a copy is not treated as a delete. Empty text is not stored.

## When it is written

In [src/core/indexer.ts](src/core/indexer.ts), both `indexDirectory` and `indexSingleImage` already build the text that is passed to `putDocuments`. When `config.indexing.ocrBackup` is true, hash the image and upsert that same text into SQLite **before** the memvid write.

If the backup is enabled and the catalog does not know the path, look up the backup by path first. Only when that misses, hash the file and look up `content_hash`. A match reuses the stored OCR text for the new path and skips OCR. A miss runs OCR as it does today, then stores the hash with the text.

Today `flushPendingDocs` only calls `putDocuments`, and a capacity error throws `IndexError` after the batch is dropped. The SQLite write stays even when that put fails, so a full `.mv2` does not discard the OCR.

`index --force` overwrites rows for paths it reprocesses. Files the catalog skips as already indexed are not re-OCRed.

## Copy what is already in memvid

At the start of `indexDirectory`, when the backup is enabled and `screenshots.mv2` exists, walk `timeline()` and `view(frameId)` the way [src/commands/browse.ts](src/commands/browse.ts) does, and insert any URI that is not already in SQLite. If that file is still on disk, hash it into `content_hash` during the copy. That copies the ~12k texts from the overnight run without running OCR again. Paths missing from memvid (the batch that hit the cap) are filled on the next index of those files.

`ssm find` is unchanged. Search still uses memvid.
