/**
 * Indexer module for screenshot-memory
 * Handles batch and incremental indexing of screenshots into the local SQLite index
 */

import { statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import pLimit from "p-limit";
import { getMemoryStats, memoryExists } from "./memory.js";
import { loadCatalog, clearCatalog } from "./catalog.js";
import { classifyImages, compareImageRecords, findScreenshotPaths, type ImageSort } from "./preflight.js";
import { initializeOcr, processImage, shutdownOcr, isValidImage, resetOcrWarningDedupe, setOcrWarningHandler } from "../ocr/index.js";
import { describeImage, shutdownVision, isVisionAvailable } from "../vision/index.js";
import { getLocalEmbedder } from "../embeddings/ollama.js";
import { hashImageFile, ocrBackupPath } from "./ocr-backup.js";
import { SearchStore, type VectorBatchItem } from "./search-store.js";
import {
  getConfig,
  logger,
  resolvePath,
  BATCH_INSERT_SIZE,
  DirectoryNotFoundError,
  NoScreenshotsFoundError,
  IndexError,
} from "../utils/index.js";

export interface IndexOptions {
  /** Directory to index. Optional when `files` is set. */
  directory?: string;
  /** Exact paths to index, in this order. Skips the directory scan and header preflight. */
  files?: string[];
  /** Order when scanning a directory. Ignored when `files` is set. */
  sort?: ImageSort;
  /** Minimum width for the header preflight. Defaults to MIN_IMAGE_DIMENSION. */
  minWidth?: number;
  /** Minimum height for the header preflight. Defaults to MIN_IMAGE_DIMENSION. */
  minHeight?: number;
  /** Force re-index all files */
  force?: boolean;
  /** Number of OCR workers */
  workers?: number;
  /** Enable image captioning for photos */
  caption?: boolean;
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;
  /** Error callback for individual files */
  onFileError?: (path: string, error: Error) => void;
  /** OCR warning tied to the file that produced it */
  onOcrWarning?: (path: string, message: string) => void;
  /** Stop scheduling new files, then flush and commit what is already done. */
  signal?: AbortSignal;
}

export interface IndexProgress {
  phase: "scanning" | "preflight" | "ocr" | "captioning" | "indexing" | "finalizing";
  current: number;
  total: number;
  totalFound?: number;
  alreadyIndexed?: number;
  currentFile?: string;
  workerCount?: number;
  activeCount?: number;
  indexed?: number;
  skipped?: number;
  failed?: number;
  /** Files whose completion should drive items/sec. Omits stored-text reuse. */
  throughput?: number;
  message?: string;
}

export interface IndexResult {
  /** Total images found */
  totalFound: number;
  /** Images skipped because already indexed */
  alreadyIndexed: number;
  /** Images rejected by the header check before OCR */
  preflightRejected: number;
  /** Images newly indexed */
  indexed: number;
  /** Images skipped (already indexed or no text) */
  skipped: number;
  /** Images that failed */
  failed: number;
  /** Total time in milliseconds */
  timeMs: number;
  /** Memory file path */
  memoryPath: string;
  /** Index size in bytes */
  indexSizeBytes: number;
  /** True when the run stopped because `signal` aborted (Ctrl+C). */
  stopped?: boolean;
}

/**
 * Index screenshots from a directory with incremental change detection and streaming workers
 */
export async function indexDirectory(options: IndexOptions): Promise<IndexResult> {
  resetOcrWarningDedupe();
  setOcrWarningHandler(options.onOcrWarning ?? null);
  try {
    return await indexDirectoryImpl(options);
  } finally {
    setOcrWarningHandler(null);
  }
}

async function indexDirectoryImpl(options: IndexOptions): Promise<IndexResult> {
  const startTime = Date.now();
  const config = getConfig();
  const indexPath = ocrBackupPath(config.memoryPath);
  let store: SearchStore | null = null;

  try {
  options.onProgress?.({
    phase: "scanning",
    current: 0,
    total: 0,
    message: "Scanning for screenshots...",
  });

  let imagePaths: string[];
  if (options.files) {
    imagePaths = options.files.map((filePath) => resolvePath(filePath));
  } else {
    if (!options.directory) {
      throw new IndexError("No directory or file list was provided.", "Pass a directory or --files <list>.");
    }
    const directory = resolvePath(options.directory);
    if (!existsSync(directory)) {
      throw new DirectoryNotFoundError(directory);
    }
    imagePaths = await findScreenshotPaths(directory);
  }

  if (imagePaths.length === 0) {
    throw new NoScreenshotsFoundError(options.directory || "file list");
  }

  logger.debug(`Found ${imagePaths.length} images`);

  // Load catalog
  const catalog = await loadCatalog(config.memoryPath);

  store = await SearchStore.open(config.memoryPath);
  const backup = store.texts;

  if (options.force) {
    catalog.clear();
    clearCatalog(config.memoryPath);
    store.clearVectors();
  }

  // Partition images: already indexed vs to-index
  let toIndex: Array<{ path: string; stat: { mtimeMs: number; size: number } }> = [];
  let alreadyIndexedCount = 0;
  let preflightRejected = 0;

  for (const p of imagePaths) {
    try {
      const stats = statSync(p);
      const fileStat = { mtimeMs: stats.mtime.getTime(), size: stats.size };
      if (!options.force && catalog.isUpToDate(p, fileStat) && store.isEmbedded(p)) {
        alreadyIndexedCount++;
      } else {
        toIndex.push({ path: p, stat: fileStat });
      }
    } catch {
      // File could not be statted (permissions, unlinked, etc.), skip
    }
  }

  // If all files are already up-to-date, finish early
  if (toIndex.length === 0) {
    options.onProgress?.({
      phase: "finalizing",
      current: 1,
      total: 1,
      message: "All screenshots are already indexed.",
    });

    const finalStats = store.stats();
    return {
      totalFound: imagePaths.length,
      alreadyIndexed: alreadyIndexedCount,
      indexed: 0,
      skipped: alreadyIndexedCount,
      preflightRejected,
      failed: 0,
      timeMs: Date.now() - startTime,
      memoryPath: indexPath,
      indexSizeBytes: finalStats.indexSizeBytes,
    };
  }

  if (!options.files && options.sort && toIndex.length > 1) {
    const sort = options.sort;
    toIndex.sort((a, b) =>
      compareImageRecords(
        { path: a.path, mtimeMs: a.stat.mtimeMs, size: a.stat.size },
        { path: b.path, mtimeMs: b.stat.mtimeMs, size: b.stat.size },
        sort
      )
    );
  }

  if (!options.files && toIndex.length > 0) {
    options.onProgress?.({
      phase: "preflight",
      current: 0,
      total: toIndex.length,
      totalFound: imagePaths.length,
      alreadyIndexed: alreadyIndexedCount,
      message: "Checking image headers...",
    });

    const classified = await classifyImages(
      toIndex.map((item) => item.path),
      {
        minWidth: options.minWidth,
        minHeight: options.minHeight,
        onProgress: (current, total) => {
          options.onProgress?.({
            phase: "preflight",
            current,
            total,
            totalFound: imagePaths.length,
            alreadyIndexed: alreadyIndexedCount,
          });
        },
      }
    );

    const rejected = new Set(classified.rejected.map((item) => item.path));
    const viable: typeof toIndex = [];
    for (const item of toIndex) {
      if (rejected.has(resolvePath(item.path))) {
        preflightRejected++;
        catalog.record(item.path, item.stat, "empty");
      } else {
        viable.push(item);
      }
    }
    toIndex = viable;

    try {
      catalog.save();
    } catch (err) {
      logger.debug(`Could not save catalog: ${err}`);
    }
  }

  if (toIndex.length === 0) {
    options.onProgress?.({
      phase: "finalizing",
      current: 1,
      total: 1,
      message: "No screenshots left to process.",
    });

    const finalStats = store.stats();
    return {
      totalFound: imagePaths.length,
      alreadyIndexed: alreadyIndexedCount,
      preflightRejected,
      indexed: 0,
      skipped: alreadyIndexedCount + preflightRejected,
      failed: 0,
      timeMs: Date.now() - startTime,
      memoryPath: indexPath,
      indexSizeBytes: finalStats.indexSizeBytes,
    };
  }

  const workerCount = Math.max(1, options.workers || config.ocr.workers || 4);
  logger.debug(`Indexing with ${workerCount} workers (${toIndex.length} new/modified, ${alreadyIndexedCount} already indexed)`);

  // Initialize OCR
  options.onProgress?.({
    phase: "ocr",
    current: 0,
    total: toIndex.length,
    totalFound: imagePaths.length,
    alreadyIndexed: alreadyIndexedCount,
    workerCount,
    throughput: 0,
    message: `Initializing OCR engine (${workerCount} workers)...`,
  });

  await initializeOcr({ workers: workerCount });

  // Check if vision is available for photos
  const visionAvailable = options.caption !== false && (await isVisionAvailable());
  if (visionAvailable) {
    logger.debug("Vision captioning enabled for photos");
  }

  // Multi-worker concurrency pipeline using p-limit
  const limit = pLimit(workerCount);
  const activeWorkers = new Map<number, string>();
  let workerSlotCounter = 0;

  let processed = 0;
  let indexed = 0;
  let skippedNoText = 0;
  let failed = 0;
  let throughput = 0;

  // Queued documents are not catalogued until the batch transaction commits.
  const pendingDocs: Array<{
    path: string;
    stat: { mtimeMs: number; size: number };
    doc: {
      title: string;
      text: string;
      tags: string[];
      metadata: Record<string, unknown>;
    };
  }> = [];

  let isFlushing = false;
  let storageError: Error | null = null;

  function indexingStopped(): boolean {
    return options.signal?.aborted === true || storageError !== null;
  }

  async function flushPendingDocs() {
    if (pendingDocs.length === 0 || isFlushing || storageError) return;
    isFlushing = true;
    const chunk = pendingDocs.splice(0, pendingDocs.length);
    try {
      const embeddings = await getLocalEmbedder().embedDocuments(chunk.map((item) => item.doc.text));
      if (embeddings.length !== chunk.length) {
        throw new Error(`Expected ${chunk.length} embeddings, got ${embeddings.length}.`);
      }
      const batch: VectorBatchItem[] = chunk.map((item, index) => ({
        path: item.path,
        embedding: embeddings[index] ?? [],
        tags: item.doc.tags,
        width: asMetaNumber(item.doc.metadata.width),
        height: asMetaNumber(item.doc.metadata.height),
      }));
      // Commit the vectors before the skip list. A crash must not mark files
      // indexed that a new process cannot see.
      if (!store) {
        throw new IndexError("Search index is not open.");
      }
      store.insertBatch(batch);
      for (const item of chunk) {
        catalog.record(item.path, item.stat, "indexed");
      }
      catalog.save();
    } catch (err) {
      storageError = err instanceof Error ? err : new Error(String(err));
      throw storageError;
    } finally {
      isFlushing = false;
    }
  }

  const tasks = toIndex.map((item) =>
    limit(async () => {
      if (indexingStopped()) return;

      const slotId = ++workerSlotCounter;
      const fileName = basename(item.path);
      activeWorkers.set(slotId, fileName);

      try {
        if (backup && !options.force && !catalog.get(item.path)) {
          const known = backup.rememberMovedFile(item.path, item.stat);
          if (known) {
            indexed++;
            processed++;
            pendingDocs.push({
              path: item.path,
              stat: item.stat,
              doc: {
                text: known.text,
                title: fileName,
                tags: [],
                metadata: {
                  path: item.path,
                  timestamp: item.stat.mtimeMs,
                  fileSize: item.stat.size,
                  confidence: known.confidence ?? 0,
                  method: known.method ?? "ocr",
                },
              },
            });
            if (pendingDocs.length >= BATCH_INSERT_SIZE) {
              await flushPendingDocs();
            }
            activeWorkers.delete(slotId);
            options.onProgress?.({
              phase: "ocr",
              current: processed,
              total: toIndex.length,
              totalFound: imagePaths.length,
              alreadyIndexed: alreadyIndexedCount,
              currentFile: fileName,
              workerCount,
              activeCount: activeWorkers.size,
              indexed,
              skipped: skippedNoText + alreadyIndexedCount + preflightRejected,
              failed,
              throughput,
            });
            return;
          }
        }

        // Quick validity check (dimensions >= 10px, readable format)
        const valid = await isValidImage(item.path);
        if (!valid) {
          skippedNoText++;
          processed++;
          throughput++;
          catalog.record(item.path, item.stat, "empty");
          activeWorkers.delete(slotId);
          options.onProgress?.({
            phase: "ocr",
            current: processed,
            total: toIndex.length,
            totalFound: imagePaths.length,
            alreadyIndexed: alreadyIndexedCount,
            currentFile: fileName,
            workerCount,
            activeCount: activeWorkers.size,
            indexed,
            skipped: skippedNoText + alreadyIndexedCount + preflightRejected,
            failed,
            throughput,
          });
          return;
        }

        // Process with OCR
        const ocrResult = await processImage(item.path);

        let text = ocrResult.text;
        let tags: string[] = [];
        let method = "ocr";

        // Clean text to evaluate if OCR extracted meaningful content
        const cleanText = ocrResult.text
          .replace(/[—–\-_=|·•◦○●▪▫■□►▶◀◄~`'".,;:!?@#$%^&*()[\]{}\\/<>]/g, "")
          .trim();
        const wordCount = cleanText.split(/\s+/).filter((w) => w.length > 2).length;
        const hasGoodText = ocrResult.hasContent && ocrResult.confidence > 40 && wordCount > 10;

        // If OCR didn't yield meaningful text, try vision captioning if available
        if (!hasGoodText && visionAvailable) {
          try {
            const visionResult = await describeImage(item.path);
            if (visionResult) {
              tags = visionResult.tags;
              text = text
                ? `${text}\n\n[Image: ${visionResult.caption}]`
                : `[Image: ${visionResult.caption}]`;
              method = ocrResult.hasContent ? "both" : "caption";
            }
          } catch (err) {
            logger.debug(`Vision failed for ${fileName}: ${err}`);
          }
        }

        // If no content extracted from either OCR or vision, skip
        if (!text.trim()) {
          skippedNoText++;
          processed++;
          throughput++;
          catalog.record(item.path, item.stat, "empty");
          activeWorkers.delete(slotId);
          options.onProgress?.({
            phase: "ocr",
            current: processed,
            total: toIndex.length,
            totalFound: imagePaths.length,
            alreadyIndexed: alreadyIndexedCount,
            currentFile: fileName,
            workerCount,
            activeCount: activeWorkers.size,
            indexed,
            skipped: skippedNoText + alreadyIndexedCount + preflightRejected,
            failed,
            throughput,
          });
          return;
        }

        // Success: queue document. The catalog entry is written after the batch commits.
        indexed++;
        processed++;
        throughput++;

        if (backup) {
          backup.upsert({
            path: item.path,
            contentHash: hashImageFile(item.path),
            text,
            title: fileName,
            mtimeMs: item.stat.mtimeMs,
            size: item.stat.size,
            confidence: ocrResult.confidence,
            method,
          });
        }

        pendingDocs.push({
          path: item.path,
          stat: item.stat,
          doc: {
            text,
            title: fileName,
            tags,
            metadata: {
              path: item.path,
              timestamp: item.stat.mtimeMs,
              fileSize: item.stat.size,
              width: ocrResult.metadata.width,
              height: ocrResult.metadata.height,
              confidence: ocrResult.confidence,
              method,
            },
          },
        });

        // If buffer reached BATCH_INSERT_SIZE, embed it and save the catalog
        if (pendingDocs.length >= BATCH_INSERT_SIZE) {
          await flushPendingDocs();
        }

        activeWorkers.delete(slotId);
        options.onProgress?.({
          phase: "ocr",
          current: processed,
          total: toIndex.length,
          totalFound: imagePaths.length,
          alreadyIndexed: alreadyIndexedCount,
          currentFile: fileName,
          workerCount,
          activeCount: activeWorkers.size,
          indexed,
          skipped: skippedNoText + alreadyIndexedCount + preflightRejected,
          failed,
          throughput,
        });
      } catch (err) {
        if (storageError) throw storageError;
        failed++;
        processed++;
        throughput++;
        catalog.record(item.path, item.stat, "failed");
        activeWorkers.delete(slotId);
        const error = err instanceof Error ? err : new Error(String(err));
        options.onFileError?.(item.path, error);
        options.onProgress?.({
          phase: "ocr",
          current: processed,
          total: toIndex.length,
          totalFound: imagePaths.length,
          alreadyIndexed: alreadyIndexedCount,
          currentFile: fileName,
          workerCount,
          activeCount: activeWorkers.size,
          indexed,
          skipped: skippedNoText + alreadyIndexedCount + preflightRejected,
          failed,
          throughput,
        });
      }
    })
  );

  await Promise.allSettled(tasks);

  try {
    if (!storageError) {
      while (pendingDocs.length > 0) {
        await flushPendingDocs();
      }
    }
  } catch (err) {
    if (!storageError) {
      storageError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // Persist empty/failed rows even when a batch could not be stored.
  try {
    catalog.save();
  } catch (err) {
    logger.debug(`Could not save catalog: ${err}`);
  }

  // Shutdown OCR and Vision engines
  await shutdownOcr();
  await shutdownVision();

  if (storageError) {
    throw new IndexError(`Failed to store documents: ${storageError.message}`);
  }

  const stopped = options.signal?.aborted === true;

  if (!stopped) {
    options.onProgress?.({
      phase: "finalizing",
      current: 1,
      total: 1,
      message: "Done!",
    });
  }

  const finalStats = store.stats();

  return {
    totalFound: imagePaths.length,
    alreadyIndexed: alreadyIndexedCount,
    preflightRejected,
    indexed,
    skipped: skippedNoText + alreadyIndexedCount + preflightRejected,
    failed,
    stopped,
    timeMs: Date.now() - startTime,
    memoryPath: indexPath,
    indexSizeBytes: finalStats.indexSizeBytes,
  };
  } finally {
    store?.close();
  }
}

/**
 * Index a single image (for watch mode and CLI)
 */
export async function indexSingleImage(
  imagePath: string,
  options?: {
    workers?: number;
    shutdownOcrAfter?: boolean;
    caption?: boolean;
    onProgress?: (phase: string, message: string) => void;
  }
): Promise<{ success: boolean; method: "ocr" | "caption" | "both" | "none" }> {
  const resolved = resolvePath(imagePath);
  const config = getConfig();

  if (!existsSync(resolved)) {
    throw new DirectoryNotFoundError(resolved);
  }

  // Check if valid image
  const valid = await isValidImage(resolved);
  if (!valid) {
    return { success: false, method: "none" };
  }

  let ocrText = "";
  let ocrConfidence = 0;
  let captionText = "";
  let captionTags: string[] = [];
  let method: "ocr" | "caption" | "both" | "none" = "none";
  let imageWidth = 0;
  let imageHeight = 0;
  let store: SearchStore | null = null;

  try {
    store = await SearchStore.open(config.memoryPath);
    const backup = store.texts;
    const fileStat = statSync(resolved);
    const catalog = await loadCatalog(config.memoryPath);
    if (!catalog.get(resolved)) {
      const known = backup.rememberMovedFile(resolved, {
        mtimeMs: fileStat.mtime.getTime(),
        size: fileStat.size,
      });
      if (known) {
        options?.onProgress?.("indexing", "Storing...");
        const [embedding] = await getLocalEmbedder().embedDocuments([known.text]);
        if (!embedding) {
          throw new Error(`Expected an embedding for ${resolved}.`);
        }
        store.insertBatch([{ path: resolved, embedding, tags: [] }]);
        try {
          catalog.record(
            resolved,
            { mtimeMs: fileStat.mtime.getTime(), size: fileStat.size },
            "indexed"
          );
          catalog.save();
        } catch (catErr) {
          logger.debug(`Could not update catalog: ${catErr}`);
        }
        if (options?.shutdownOcrAfter) {
          await shutdownOcr();
          await shutdownVision();
        }
        return { success: true, method: storedIndexMethod(known.method) };
      }
    }

    // Smart strategy: Try vision first (faster for photos), then OCR if needed
    const visionReady = options?.caption !== false && (await isVisionAvailable());

    if (visionReady) {
      // Step 1: Try vision captioning first
      options?.onProgress?.("caption", "Analyzing image...");
      const visionResult = await describeImage(resolved);

      if (visionResult) {
        captionText = visionResult.caption;
        captionTags = visionResult.tags;
        logger.debug(`Vision caption (${visionResult.processingTimeMs}ms): ${captionText.slice(0, 100)}...`);
      }
    }

    // Step 2: Only run OCR if we don't have a good caption
    const needsOcr = !captionText || options?.caption === false;

    if (needsOcr) {
      options?.onProgress?.("ocr", "Extracting text...");
      await initializeOcr({ workers: options?.workers || 1 });
      const ocrResult = await processImage(resolved);
      ocrText = ocrResult.text;
      ocrConfidence = ocrResult.confidence;
      imageWidth = ocrResult.metadata.width;
      imageHeight = ocrResult.metadata.height;
    } else {
      // Get image dimensions without full OCR
      const { getImageMetadata } = await import("../ocr/index.js");
      const meta = await getImageMetadata(resolved);
      imageWidth = meta.width;
      imageHeight = meta.height;
    }

    // Determine method used
    if (ocrText && captionText) {
      method = "both";
    } else if (captionText) {
      method = "caption";
    } else if (ocrText) {
      method = "ocr";
    }

    // Combine text for indexing
    const combinedText = [
      ocrText,
      captionText ? `[Image description: ${captionText}]` : "",
      captionTags.length ? `[Tags: ${captionTags.join(", ")}]` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // Get file stats
    const stats = statSync(resolved);

    // Skip if no content at all
    if (!combinedText.trim()) {
      try {
        const catalog = await loadCatalog(config.memoryPath);
        catalog.record(resolved, { mtimeMs: stats.mtime.getTime(), size: stats.size }, "empty");
        catalog.save();
      } catch {}

      if (options?.shutdownOcrAfter) {
        await shutdownOcr();
        await shutdownVision();
      }
      return { success: false, method: "none" };
    }

    backup.upsert({
      path: resolved,
      contentHash: hashImageFile(resolved),
      text: combinedText,
      title: basename(resolved),
      mtimeMs: stats.mtime.getTime(),
      size: stats.size,
      confidence: ocrConfidence,
      method,
      tags: captionTags,
      width: imageWidth,
      height: imageHeight,
    });

    options?.onProgress?.("indexing", "Storing...");
    const [embedding] = await getLocalEmbedder().embedDocuments([combinedText]);
    if (!embedding) {
      throw new Error(`Expected an embedding for ${resolved}.`);
    }
    store.insertBatch([{
      path: resolved,
      embedding,
      tags: captionTags,
      width: imageWidth,
      height: imageHeight,
    }]);

    // Record in catalog
    try {
      const catalog = await loadCatalog(config.memoryPath);
      catalog.record(resolved, { mtimeMs: stats.mtime.getTime(), size: stats.size }, "indexed");
      catalog.save();
    } catch (catErr) {
      logger.debug(`Could not update catalog: ${catErr}`);
    }

    // Shutdown if requested
    if (options?.shutdownOcrAfter) {
      await shutdownOcr();
      await shutdownVision();
    }

    return { success: true, method };
  } catch (err) {
    if (options?.shutdownOcrAfter) {
      await shutdownOcr();
      await shutdownVision();
    }
    logger.debug(`Failed to index ${resolved}: ${err}`);
    return { success: false, method: "none" };
  } finally {
    store?.close();
  }
}

function storedIndexMethod(method: string | null): "ocr" | "caption" | "both" {
  if (method === "caption" || method === "both" || method === "ocr") return method;
  return "ocr";
}

/**
 * Get index statistics
 */
export async function getIndexStats(): Promise<{
  documentCount: number;
  indexSizeBytes: number;
  hasLexIndex: boolean;
  hasVecIndex: boolean;
  memoryPath: string;
}> {
  const config = getConfig();

  if (!memoryExists()) {
    return {
      documentCount: 0,
      indexSizeBytes: 0,
      hasLexIndex: false,
      hasVecIndex: false,
      memoryPath: ocrBackupPath(config.memoryPath),
    };
  }

  const stats = await getMemoryStats();

  return {
    documentCount: stats.frameCount,
    indexSizeBytes: stats.usedBytes,
    hasLexIndex: stats.hasLexIndex,
    hasVecIndex: stats.hasVecIndex,
    memoryPath: stats.memoryPath,
  };
}

function asMetaNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
