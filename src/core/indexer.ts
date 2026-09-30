/**
 * Indexer module for screenshot-memory
 * Handles batch indexing of screenshots into memvid
 */

import { glob } from "glob";
import { statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { getMemory, createMemory, memoryExists, getMemoryStats } from "./memory.js";
import { initializeOcr, processImage, shutdownOcr, isValidImage } from "../ocr/index.js";
import { describeImage, shutdownVision, isVisionAvailable } from "../vision/index.js";
import { getLocalEmbedder } from "../embeddings/ollama.js";
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
  currentFile?: string;
  message?: string;
}

export interface IndexResult {
  /** Total images found */
  totalFound: number;
  /** Images successfully indexed */
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
 * Index screenshots from a directory
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
  const pattern = join(directory, "**", SUPPORTED_EXTENSIONS_GLOB);
  const imagePaths = await glob(pattern, {
    nodir: true,
    absolute: true,
  });

  if (imagePaths.length === 0) {
    throw new NoScreenshotsFoundError(directory);
  }

  logger.debug(`Found ${imagePaths.length} images in ${directory}`);

  // Get or create memory
  const isNewIndex = !memoryExists() || options.force;
  const mv = isNewIndex
    ? await createMemory()
    : await getMemory({ create: true });

  // Get existing indexed paths (for incremental indexing)
  const indexedPaths = new Set<string>();
  if (!isNewIndex && !options.force) {
    try {
      const stats = await getMemoryStats();
      if (stats.frameCount > 0) {
        // We can't easily get all indexed paths from memvid
        // So for incremental, we'll rely on file modification time
        // This is a simplification - a production version might use a separate index
        logger.debug(`Existing index has ${stats.frameCount} documents`);
      }
    } catch (err) {
      logger.debug(`Could not get existing index stats: ${err}`);
    }
  }

  // Filter to unindexed images (simplified - indexes all if force or new)
  const toIndex = options.force || isNewIndex
    ? imagePaths
    : imagePaths.filter(p => !indexedPaths.has(p));

  logger.debug(`Will index ${toIndex.length} images`);

  // Initialize OCR
  options.onProgress?.({
    phase: "ocr",
    current: 0,
    total: toIndex.length,
    message: "Initializing OCR engine...",
  });

  await initializeOcr({ workers: options.workers || config.ocr.workers });

  // Check if vision is available for photos
  const visionAvailable = await isVisionAvailable();
  if (visionAvailable) {
    logger.debug("Vision captioning available for photos");
  }

  // Process images with OCR + Vision
  const documents: Array<{
    text: string;
    title: string;
    label: string;
    tags?: string[];
    metadata: Record<string, unknown>;
  }> = [];

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  // Process in batches to manage memory
  const batchSize = 50;
  for (let i = 0; i < toIndex.length; i += batchSize) {
    const batch = toIndex.slice(i, i + batchSize);

    const batchPromises = batch.map(async (imagePath) => {
      try {
        // Check if valid image
        const valid = await isValidImage(imagePath);
        if (!valid) {
          skipped++;
          processed++;
          options.onProgress?.({
            phase: "ocr",
            current: processed,
            total: toIndex.length,
            currentFile: basename(imagePath),
          });
          return null;
        }

        // First try OCR (fast)
        const ocrResult = await processImage(imagePath);

        processed++;
        options.onProgress?.({
          phase: "ocr",
          current: processed,
          total: toIndex.length,
          currentFile: basename(imagePath),
        });

        let text = ocrResult.text;
        let tags: string[] = [];
        let method = "ocr";

        // Only run vision if OCR didn't find meaningful text
        // This is much faster - vision only runs on photos, not text-heavy screenshots
        // Filter out garbage OCR (repeated characters, symbols, etc.)
        const cleanText = ocrResult.text.replace(/[—–\-_=|·•◦○●▪▫■□►▶◀◄~`'".,;:!?@#$%^&*()[\]{}\\/<>]/g, '').trim();
        const wordCount = cleanText.split(/\s+/).filter(w => w.length > 2).length;
        const hasGoodText = ocrResult.hasContent && ocrResult.confidence > 40 && wordCount > 10;

        if (!hasGoodText && visionAvailable) {
          try {
            const visionResult = await describeImage(imagePath);
            if (visionResult) {
              tags = visionResult.tags;
              text = text
                ? `${text}\n\n[Image: ${visionResult.caption}]`
                : `[Image: ${visionResult.caption}]`;
              method = ocrResult.hasContent ? "both" : "caption";
            }
          } catch (err) {
            logger.debug(`Vision failed for ${basename(imagePath)}: ${err}`);
          }
        }

        // Skip if no content at all
        if (!text.trim()) {
          skipped++;
          return null;
        }

        // Get file stats
        const stats = statSync(imagePath);

        return {
          text,
          title: basename(imagePath),
          label: DOCUMENT_LABEL,
          tags,
          metadata: {
            path: imagePath,
            timestamp: stats.mtime.getTime(),
            fileSize: stats.size,
            width: ocrResult.metadata.width,
            height: ocrResult.metadata.height,
            confidence: ocrResult.confidence,
            method,
          },
        };
      } catch (err) {
        failed++;
        processed++;
        const error = err instanceof Error ? err : new Error(String(err));
        options.onFileError?.(imagePath, error);
        options.onProgress?.({
          phase: "ocr",
          current: processed,
          total: toIndex.length,
          currentFile: basename(imagePath),
        });
        return null;
      }
    });

    const batchResults = await Promise.all(batchPromises);

    // Add successful results to documents
    for (const doc of batchResults) {
      if (doc) {
        documents.push(doc);
      }
    }
  }

  // Shutdown OCR and Vision
  await shutdownOcr();
  await shutdownVision();

  // Index documents into memvid
  options.onProgress?.({
    phase: "indexing",
    current: 0,
    total: documents.length,
    message: "Storing documents in memory...",
  });

  if (documents.length > 0) {
    try {
      // Insert in batches
      for (let i = 0; i < documents.length; i += BATCH_INSERT_SIZE) {
        const batch = documents.slice(i, i + BATCH_INSERT_SIZE);

        await mv.putMany(
          batch.map((doc) => ({
            title: doc.title,
            text: doc.text,
            labels: [doc.label],
            tags: doc.tags,
            metadata: doc.metadata,
          })),
          {
            compressionLevel: config.indexing.compressionLevel,
            embedder: getLocalEmbedder(),
          }
        );

        options.onProgress?.({
          phase: "indexing",
          current: Math.min(i + BATCH_INSERT_SIZE, documents.length),
          total: documents.length,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new IndexError(`Failed to store documents: ${message}`);
    }
  }

  // Finalize index
  options.onProgress?.({
    phase: "finalizing",
    current: 0,
    total: 1,
    message: "Optimizing index...",
  });

  try {
    await mv.seal();
    // Note: rebuildTimeIndex might not be available in all SDK versions
    // await mv.rebuildTimeIndex();
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
    indexed: documents.length,
    skipped,
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
    const visionReady = options?.caption !== false && await isVisionAvailable();

    if (visionReady) {
      // Step 1: Try vision captioning first (fast: ~300ms)
      options?.onProgress?.("caption", "Analyzing image...");
      const visionResult = await describeImage(resolved);

      if (visionResult) {
        captionText = visionResult.caption;
        captionTags = visionResult.tags;
        logger.debug(`Vision caption (${visionResult.processingTimeMs}ms): ${captionText.slice(0, 100)}...`);
      }
    }

    // Step 2: Only run OCR if we don't have a good caption (OCR is slow ~2-3s)
    // For photos, caption is enough. For screenshots, we need OCR.
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

    // Skip if no content at all
    if (!combinedText.trim()) {
      if (options?.shutdownOcrAfter) {
        await shutdownOcr();
        await shutdownVision();
      }
      return { success: false, method: "none" };
    }

    // Get file stats
    const stats = statSync(resolved);

    // Get memory (create if needed)
    const mv = await getMemory({ create: true });

    // Add to index
    options?.onProgress?.("indexing", "Storing...");
    await mv.putMany(
      [{
        text: combinedText,
        title: basename(resolved),
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
      }],
      { embedder: getLocalEmbedder() }
    );

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
