# Implementation Plan: Incremental Indexing, Enhanced Progress UI, and Multi-Worker Mode

## Overview
This plan addresses the issues encountered when indexing large screenshot directories with `ssm index`:
1. **Preventing Re-indexing**: Skip images that have already been indexed (and unchanged) unless `--force` is specified.
2. **Enhanced Index Interface**: Live display of current file(s) being processed, elapsed time, accurate ETA, progress percentage, file counts, and processing rate without terminal corruption.
3. **Robust Multi-Worker Mode**: Fully utilize `-w, --workers <N>` (e.g. `-w 8`) with a continuous streaming pipeline using `p-limit` and periodic batch persistence into Memvid.
4. **Clean Terminal Output**: Suppress Leptonica/Tesseract Wasm warnings (`Image too small to scale!!`, `Line cannot be recognized!!`) and filter out tiny non-OCR images (<10px).

---

## Architecture & Root Cause Analysis

### 1. Why Images Were Re-indexed Every Time
In [`src/core/indexer.ts`](file:///c:/Users/pho/repos/PHO_EXPLORATION/screenshot-memory/src/core/indexer.ts#L107-L128):
```typescript
const indexedPaths = new Set<string>();
if (!isNewIndex && !options.force) {
  // Existing index has stats.frameCount documents
  // Placeholder comment: "We can't easily get all indexed paths from memvid..."
}
const toIndex = options.force || isNewIndex
  ? imagePaths
  : imagePaths.filter(p => !indexedPaths.has(p));
```
`indexedPaths` was an empty `Set`, meaning all images were treated as unindexed and re-processed on every run, resulting in redundant hours of OCR and duplicate entries.

**Solution**: Implement an **Index Catalog** ([`src/core/catalog.ts`](file:///c:/Users/pho/repos/PHO_EXPLORATION/screenshot-memory/src/core/catalog.ts)) stored alongside the database as `${memoryPath}.manifest.json`. It tracks each file's normalized path, modification time (`mtimeMs`), size (`sizeBytes`), status (`"indexed"` | `"empty"` | `"failed"`), and timestamp. If `mtimeMs` and `size` match, the file is skipped in O(1) time.

### 2. Why the Terminal Output Was Mangled
In the user's terminal:
```
Processing 13,645 screenshots...
Image too small to scale!! (2x36 vs min width of 3)
Line cannot be recognized!!
```
These lines are emitted by Leptonica (`scale.c: pixScale`) directly through WebAssembly/C stdout/stderr when processing tiny images (e.g. 1x36, 2x36 separator lines or slices).
- [`isValidImage()`](file:///c:/Users/pho/repos/PHO_EXPLORATION/screenshot-memory/src/ocr/preprocess.ts#L122) only checked `width && height > 0`.
- The global noise filters in `cli.ts` and `tesseract.ts` did not match these Leptonica messages.
- The raw stdout writes interrupted `cli-progress`, displacing the cursor and breaking line redraws.

**Solution**:
1. Filter out images with `width < 10 || height < 10` before sending to Tesseract (mark as empty).
2. Intercept and silence Leptonica/Tesseract scale warnings in `process.stdout.write` and `process.stderr.write`.

### 3. Worker Architecture Bottlenecks
- `batchSize = 50` mapped 50 items simultaneously with `Promise.all`, creating lockstep barriers where 1 slow image stalled 49 others.
- All documents were held in RAM until the very end before calling `putDocuments()`. If interrupted, all work was lost.
- Concurrency was not aligned with `-w` (workers) option.

**Solution**:
Use a streaming worker pool with `p-limit(workers)`. Files are pulled continuously by available workers, results are buffered and periodically flushed to Memvid in batches of 50, and manifest updates are saved atomically.

---

## Proposed Changes

### 1. New Module: Index Catalog (`src/core/catalog.ts`)
Create a persistent catalog system:
- **Interface**:
  ```typescript
  export interface CatalogEntry {
    path: string;
    mtimeMs: number;
    size: number;
    indexedAt: number;
    status: "indexed" | "empty" | "failed";
  }
  ```
- **Operations**:
  - `loadCatalog(memoryPath: string)`: Reads `${memoryPath}.manifest.json` safely (or initializes empty).
  - `isUpToDate(entry, fileStats)`: Compares `mtimeMs` and `size`.
  - `saveCatalog(memoryPath, catalog)`: Atomic write via `.tmp` file and rename.
  - `flush()`: Debounced / periodic saving so progress survives interrupts (Ctrl+C).

### 2. Preprocessing & Noise Suppression
- **[`src/ocr/preprocess.ts`](file:///c:/Users/pho/repos/PHO_EXPLORATION/screenshot-memory/src/ocr/preprocess.ts)**:
  - Update `isValidImage()` to check minimum dimensions (`width >= 10 && height >= 10`).
  - Update `preprocessImage()` to skip scaling if dimensions are already within bounds or too small.
- **[`src/ocr/tesseract.ts`](file:///c:/Users/pho/repos/PHO_EXPLORATION/screenshot-memory/src/ocr/tesseract.ts)** and **[`src/cli.ts`](file:///c:/Users/pho/repos/PHO_EXPLORATION/screenshot-memory/src/cli.ts)**:
  - Add noise suppression for `"Image too small to scale"`, `"min width of 3"`, `"Line cannot be recognized"`, and related Leptonica logs across stdout/stderr.

### 3. Core Indexer Refactoring (`src/core/indexer.ts`)
- **Incremental Filtering**:
  - Load catalog; partition images into `alreadyIndexed` and `toIndex`.
  - If `toIndex.length === 0`, report immediately and exit gracefully.
- **Streaming Multi-Worker Pipeline**:
  - Use `pLimit(workerCount)` matching `-w <number>`.
  - Maintain an `activeWorkers` map (`workerId -> currentFile`) for live UI display.
  - As workers complete images, push documents to `pendingBatch`.
  - When `pendingBatch.length >= BATCH_INSERT_SIZE` (50):
    - Flush to Memvid via `putDocuments()`.
    - Flush catalog to disk.
    - Clear `pendingBatch`.
- **Propagate CLI Options**:
  - Ensure `workers` and `caption` (`boolean`) options are passed from CLI down to indexer and vision modules.
- **Single Image Indexing**:
  - Update `indexSingleImage()` to update the catalog as well.

### 4. Progress Display Redesign (`src/display/progress.ts` & `src/commands/index-cmd.ts`)
- **IndexProgress Interface**:
  ```typescript
  export interface IndexProgress {
    phase: "scanning" | "ocr" | "indexing" | "finalizing";
    current: number;
    total: number;
    currentFile?: string;
    activeFiles?: string[];
    indexed?: number;
    skipped?: number;
    failed?: number;
    elapsedMs?: number;
    etaMs?: number;
    rate?: number;
  }
  ```
- **Live Terminal Display**:
  - Custom `cli-progress` formatter showing:
    - Progress Bar: `[██████████░░░░░░░░] 52.4%`
    - File counts: `338/645 files (13,338/13,645 total)`
    - Timing: `⏱ Elapsed: 1m 14s | ETA: 1m 08s`
    - Speed: `Rate: 4.6 files/s`
    - Worker Status: `Workers (8): screenshot_01.png (+7 active)`
    - Counters: `Indexed: 312 | Skipped: 26 | Failed: 0`
  - Filename truncation to terminal width (`process.stdout.columns`) to avoid wrapping.
- **Header & Summary Updates**:
  - Header displays directory, worker count, vision status, and mode (Incremental vs Force).
  - Pre-scan message: `✔ Found 13,645 screenshots (13,000 already indexed, 645 new to process)`
  - Summary includes breakdown: `Total found`, `Already indexed`, `Newly indexed`, `No text/empty`, `Failed`, `Elapsed time`, `Average speed`, and `Index size`.

---

## Step-by-Step Implementation Order

1. **Step 1: Create `src/core/catalog.ts`**
   - Implement `IndexCatalog` class and functions: `loadCatalog`, `saveCatalog`, `isIndexed`, `recordEntry`, `clearCatalog`.
   - Add unit tests or validation scripts in `scratch/`.

2. **Step 2: Fix Noise Suppression & Minimum Dimensions**
   - In `src/ocr/preprocess.ts`: Update `isValidImage` to enforce `width >= 10 && height >= 10`.
   - In `src/ocr/tesseract.ts` and `src/cli.ts`: Expand noise suppression filters to catch Leptonica/Tesseract terminal noise.

3. **Step 3: Update Progress Tracker & UI**
   - In `src/display/progress.ts`: Add custom formatter for `cli-progress` with elapsed time, ETA, rate calculation, file counts, and active worker file tracking with column-width truncation.

4. **Step 4: Refactor Indexer (`src/core/indexer.ts`)**
   - Integrate `IndexCatalog` to skip already-indexed files.
   - Refactor batch processing to use `pLimit(workers)` streaming worker pool.
   - Implement continuous buffering and periodic Memvid ingestion.
   - Update `indexSingleImage` to record to catalog.

5. **Step 5: Update CLI Command (`src/commands/index-cmd.ts`)**
   - Pass `workers` and `caption` options properly.
   - Handle pre-scan reporting (already indexed vs to-index).
   - Display enhanced summary statistics.

6. **Step 6: Build & Verification**
   - Run `npm run typecheck` (`tsc --noEmit`).
   - Run test indexing on `examples/` screenshots with `-w 4` and `-w 8`.
   - Verify second run completes instantaneously (skipping already indexed files).
   - Verify `-f` / `--force` re-indexes all images.
   - Verify tiny/corrupt images do not emit Leptonica errors.

---

## Verification Plan

### Automated Checks
- `npm run typecheck`: Ensure TypeScript compiles with zero errors.

### Manual / Integration Scenarios
1. **Initial Indexing**:
   - Run `ssm index ./examples -w 4`.
   - Verify: Progress bar shows live elapsed time, ETA, file counts, active files, and completion summary.
   - Check that `${memoryPath}.manifest.json` is created with entries for each image.

2. **Incremental Indexing (Second Run)**:
   - Run `ssm index ./examples -w 4` again without `--force`.
   - Verify: Output reports `All X screenshots are already indexed. Use --force to re-index.` and exits within ~1 second without running OCR.

3. **Multi-Worker Execution**:
   - Run `ssm index ./examples -w 8 --force`.
   - Verify: 8 workers initialize and run concurrently without thread race conditions or crashes.

4. **Noisy / Tiny Image Suppression**:
   - Create a test 2x36 image in `scratch/`.
   - Index the directory containing it.
   - Verify: No `Image too small to scale!!` or `Line cannot be recognized!!` warnings appear in the terminal, and the progress bar renders smoothly.

5. **Interruption Resilience**:
   - Start indexing a directory, interrupt with `Ctrl+C` after partial progress.
   - Restart indexing.
   - Verify: Only remaining unindexed files are processed.
