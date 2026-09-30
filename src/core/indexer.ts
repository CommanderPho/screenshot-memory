/**
 * Indexer module for screenshot-memory
 * Handles batch and incremental indexing of screenshots into memvid
 */

import { glob } from "glob";
import { statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import pLimit from "p-limit";
import { getMemory, createMemory, memoryExists, getMemoryStats } from "./memory.js";
import { loadCatalog, clearCatalog } from "./catalog.js";
import { initializeOcr, processImage, shutdownOcr, isValidImage } from "../ocr/index.js";
import { describeImage, shutdownVision, isVisionAvailable } from "../vision/index.js";
import { putDocuments } from "../embeddings/ollama.js";
import {
  getConfig,
  logger,
  resolvePath,
  SUPPORTED_EXTENSIONS_GLOB,
  DOCUMENT_LABEL,
  BATCH_INSERT_SIZE,
  DirectoryNotFoundError,
  NoScreenshotsFoundError,
  IndexError,
} from "../utils/index.js";

export interface IndexOptions {
  /** Directory to index */
  directory: string;
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
}

export interface IndexProgress {
  phase: "scanning" | "ocr" | "captioning" | "indexing" | "finalizing";
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
  message?: string;
}

export interface IndexResult {
  /** Total images found */
  totalFound: number;
  /** Images skipped because already indexed */
  alreadyIndexed: number;
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
}

/**
 * Index screenshots from a directory with incremental change detection and streaming workers
 */
export async function indexDirectory(options: IndexOptions): Promise<IndexResult> {
  const startTime = Date.now();
  const config = getConfig();

  // Resolve directory path
  const directory = resolvePath(options.directory);

  // Validate directory exists
  if (!existsSync(directory)) {
    throw new DirectoryNotFoundError(directory);
  }

  // Report scanning phase
  options.onProgress?.({
    phase: "scanning",
    current: 0,
    total: 0,
    message: "Scanning for screenshots...",
  });

  // Find all images
  const pattern = join(directory, "**", SUPPORTED_EXTENSIONS_GLOB).replace(/\\/g, "/");
  const imagePaths = await glob(pattern, {
    nodir: true,
    absolute: true,
  });

  if (imagePaths.length === 0) {
    throw new NoScreenshotsFoundError(directory);
  }

  logger.debug(`Found ${imagePaths.length} images in ${directory}`);

  // Load catalog
  const catalog = await loadCatalog(config.memoryPath);

  if (options.force) {
    catalog.clear();
    clearCatalog(config.memoryPath);
  }

  // Get or create memory
  const isNewIndex = !memoryExists() || options.force;
  const mv = isNewIndex
    ? await createMemory()
    : await getMemory({ create: true });

  // Partition images: already indexed vs to-index
  const toIndex: Array<{ path: string; stat: { mtimeMs: number; size: number } }> = [];
  let alreadyIndexedCount = 0;

  for (const p of imagePaths) {
    try {
      const stats = statSync(p);
      const fileStat = { mtimeMs: stats.mtime.getTime(), size: stats.size };
      if (!options.force && catalog.isUpToDate(p, fileStat)) {
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

    const finalStats = await getMemoryStats();
    return {
      totalFound: imagePaths.length,
      alreadyIndexed: alreadyIndexedCount,
      indexed: 0,
      skipped: alreadyIndexedCount,
      failed: 0,
      timeMs: Date.now() - startTime,
      memoryPath: config.memoryPath,
      indexSizeBytes: finalStats.usedBytes,
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

  // Buffer for periodic batch insertion into Memvid
  const pendingDocs: Array<{
    title: string;
    text: string;
    uri: string;
    labels: string[];
    tags: string[];
    metadata: Record<string, unknown>;
  }> = [];

  let isFlushing = false;
  let flushError: Error | null = null;

  async function flushPendingDocs() {
    if (pendingDocs.length === 0 || isFlushing) return;
    isFlushing = true;
    const chunk = pendingDocs.splice(0, pendingDocs.length);
    try {
      await putDocuments(mv, chunk);
      catalog.save();
    } catch (err) {
      flushError = err instanceof Error ? err : new Error(String(err));
      logger.debug(`Error flushing documents to memory: ${flushError.message}`);
    } finally {
      isFlushing = false;
    }
  }

  const tasks = toIndex.map((item) =>
    limit(async () => {
      const slotId = ++workerSlotCounter;
      const fileName = basename(item.path);
      activeWorkers.set(slotId, fileName);

      try {
        // Quick validity check (dimensions >= 10px, readable format)
        const valid = await isValidImage(item.path);
        if (!valid) {
          skippedNoText++;
          processed++;
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
            skipped: skippedNoText + alreadyIndexedCount,
            failed,
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
            skipped: skippedNoText + alreadyIndexedCount,
            failed,
          });
          return;
        }

        // Success: queue document
        indexed++;
        processed++;
        catalog.record(item.path, item.stat, "indexed");

        pendingDocs.push({
          text,
          title: fileName,
          uri: item.path,
          labels: [DOCUMENT_LABEL],
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
        });

        // If buffer reached BATCH_INSERT_SIZE, flush to Memvid and save catalog
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
          skipped: skippedNoText + alreadyIndexedCount,
          failed,
        });
      } catch (err) {
        failed++;
        processed++;
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
          skipped: skippedNoText + alreadyIndexedCount,
          failed,
        });
      }
    })
  );

  await Promise.all(tasks);

  // Flush remaining queued documents
  while (pendingDocs.length > 0) {
    await flushPendingDocs();
  }

  if (flushError) {
    throw new IndexError(`Failed to store documents: ${(flushError as Error).message}`);
  }

  // Save final catalog
  try {
    catalog.save();
  } catch (err) {
    logger.debug(`Could not save catalog: ${err}`);
  }

  // Shutdown OCR and Vision engines
  await shutdownOcr();
  await shutdownVision();

  // Finalize index
  options.onProgress?.({
    phase: "finalizing",
    current: 0,
    total: 1,
    message: "Optimizing index...",
  });

  try {
    await mv.seal();
  } catch (err) {
    logger.debug(`Finalization warning: ${err}`);
  }

  options.onProgress?.({
    phase: "finalizing",
    current: 1,
    total: 1,
    message: "Done!",
  });

  // Get final stats
  const finalStats = await getMemoryStats();

  return {
    totalFound: imagePaths.length,
    alreadyIndexed: alreadyIndexedCount,
    indexed,
    skipped: skippedNoText + alreadyIndexedCount,
    failed,
    timeMs: Date.now() - startTime,
    memoryPath: config.memoryPath,
    indexSizeBytes: finalStats.usedBytes,
  };
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

  try {
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

    // Get memory (create if needed)
    const mv = await getMemory({ create: true });

    // Add to index
    options?.onProgress?.("indexing", "Storing...");
    await putDocuments(mv, [
      {
        text: combinedText,
        title: basename(resolved),
        uri: resolved,
        labels: [DOCUMENT_LABEL],
        tags: captionTags,
        metadata: {
          path: resolved,
          timestamp: stats.mtime.getTime(),
          fileSize: stats.size,
          width: imageWidth,
          height: imageHeight,
          confidence: ocrConfidence,
          hasCaption: !!captionText,
          method,
        },
      },
    ]);

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
  }
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
      memoryPath: config.memoryPath,
    };
  }

  const stats = await getMemoryStats();

  return {
    documentCount: stats.frameCount,
    indexSizeBytes: stats.usedBytes,
    hasLexIndex: stats.hasLexIndex,
    hasVecIndex: stats.hasVecIndex,
    memoryPath: config.memoryPath,
  };
}
