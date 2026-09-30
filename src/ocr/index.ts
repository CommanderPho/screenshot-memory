/**
 * OCR module for screenshot-memory
 * Provides a unified interface for text extraction from images
 */

import {
  getTesseractEngine,
  initializeTesseract,
  shutdownTesseract,
  recognizeText as tesseractRecognize,
} from "./tesseract.js";
import { isValidImage } from "./preprocess.js";
import { getConfig, logger, OcrError } from "../utils/index.js";
import { MIN_TEXT_LENGTH } from "../utils/constants.js";
import type { OcrResult, OcrEngineOptions, ImageMetadata } from "./types.js";

export type { OcrResult, OcrEngineOptions, ImageMetadata };

// Track initialization state
let initialized = false;

/**
 * Initialize the OCR engine
 */
export async function initializeOcr(options?: OcrEngineOptions): Promise<void> {
  const config = getConfig();
  const engine = config.ocr.engine;

  const ocrOptions: OcrEngineOptions = {
    workers: options?.workers || config.ocr.workers,
    language: options?.language || config.ocr.language,
    ...options,
  };

  if (initialized) {
    await initializeTesseract(ocrOptions);
    return;
  }

  logger.debug(`Initializing OCR engine: ${engine}`);

  if (engine === "paddle") {
    // Check if PaddleOCR is available
    const hasPaddle = await checkPaddleOcr();
    if (!hasPaddle) {
      logger.warn("PaddleOCR not available, falling back to Tesseract");
      await initializeTesseract(ocrOptions);
    } else {
      // PaddleOCR initialization would go here
      // For now, we use Tesseract as the only implementation
      await initializeTesseract(ocrOptions);
    }
  } else {
    await initializeTesseract(ocrOptions);
  }

  initialized = true;
}

/**
 * Check if PaddleOCR is available
 */
async function checkPaddleOcr(): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("python3 -c 'from paddleocr import PaddleOCR'", {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Recognize text from an image
 */
export async function recognizeText(imagePath: string): Promise<OcrResult> {
  if (!initialized) {
    await initializeOcr();
  }

  // Validate image first
  const valid = await isValidImage(imagePath);
  if (!valid) {
    throw new OcrError(`Invalid or unreadable image: ${imagePath}`, imagePath);
  }

  return tesseractRecognize(imagePath);
}

/**
 * Process an image and return OCR result with metadata
 * This is the main function used by the indexer
 */
export async function processImage(imagePath: string): Promise<{
  text: string;
  confidence: number;
  metadata: ImageMetadata;
  processingTimeMs: number;
  hasContent: boolean;
}> {
  if (!initialized) {
    await initializeOcr();
  }

  const result = await recognizeText(imagePath);

  // Check if the text has meaningful content
  const cleanedText = result.text.replace(/\s+/g, " ").trim();
  const hasContent = cleanedText.length >= MIN_TEXT_LENGTH;

  return {
    text: cleanedText,
    confidence: result.confidence,
    metadata: {
      width: result.width,
      height: result.height,
      format: "unknown", // Will be filled by preprocessor
      size: 0,
    },
    processingTimeMs: result.processingTimeMs,
    hasContent,
  };
}

/**
 * Batch process multiple images with progress callback
 */
export async function processImages(
  imagePaths: string[],
  options?: {
    onProgress?: (completed: number, total: number, current: string) => void;
    onError?: (path: string, error: Error) => void;
    concurrency?: number;
  }
): Promise<
  Array<{
    path: string;
    text: string;
    confidence: number;
    metadata: ImageMetadata;
    processingTimeMs: number;
    hasContent: boolean;
    error?: string;
  }>
> {
  if (!initialized) {
    await initializeOcr();
  }

  const { default: pLimit } = await import("p-limit");
  const concurrency = options?.concurrency || getConfig().ocr.workers;
  const limit = pLimit(concurrency);

  const results: Array<{
    path: string;
    text: string;
    confidence: number;
    metadata: ImageMetadata;
    processingTimeMs: number;
    hasContent: boolean;
    error?: string;
  }> = [];

  let completed = 0;
  const total = imagePaths.length;

  const tasks = imagePaths.map((imagePath) =>
    limit(async () => {
      try {
        const result = await processImage(imagePath);
        completed++;
        options?.onProgress?.(completed, total, imagePath);

        return {
          path: imagePath,
          ...result,
        };
      } catch (err) {
        completed++;
        const error = err instanceof Error ? err : new Error(String(err));
        options?.onError?.(imagePath, error);
        options?.onProgress?.(completed, total, imagePath);

        return {
          path: imagePath,
          text: "",
          confidence: 0,
          metadata: { width: 0, height: 0, format: "unknown", size: 0 },
          processingTimeMs: 0,
          hasContent: false,
          error: error.message,
        };
      }
    })
  );

  const taskResults = await Promise.all(tasks);
  results.push(...taskResults);

  return results;
}

/**
 * Shutdown the OCR engine
 */
export async function shutdownOcr(): Promise<void> {
  if (initialized) {
    await shutdownTesseract();
    initialized = false;
  }
}

/**
 * Check if OCR is initialized
 */
export function isOcrInitialized(): boolean {
  return initialized;
}

/**
 * Get the current OCR engine name
 */
export function getOcrEngineName(): string {
  return getTesseractEngine().name;
}

// Re-export useful functions
export { getImageMetadata, isValidImage, preprocessImage } from "./preprocess.js";
