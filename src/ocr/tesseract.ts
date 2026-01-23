/**
 * Tesseract.js OCR engine with scheduler for parallel processing
 * Based on Tesseract.js v5+ API
 */

import { createWorker, createScheduler, type Scheduler, type Worker } from "tesseract.js";
import { preprocessImage, preprocessBuffer } from "./preprocess.js";
import { OcrError, logger } from "../utils/index.js";
import { OCR_TIMEOUT, DEFAULT_CONFIG } from "../utils/constants.js";
import type { OcrEngine, OcrResult, OcrEngineOptions } from "./types.js";

class TesseractEngine implements OcrEngine {
  public readonly name = "tesseract";

  private scheduler: Scheduler | null = null;
  private workers: Worker[] = [];
  private initialized = false;
  private workerCount: number = DEFAULT_CONFIG.ocr.workers;
  private language: string = DEFAULT_CONFIG.ocr.language;

  /**
   * Initialize the OCR engine with a worker pool using scheduler
   */
  async initialize(options?: OcrEngineOptions): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.workerCount = options?.workers || DEFAULT_CONFIG.ocr.workers;
    this.language = options?.language || DEFAULT_CONFIG.ocr.language;

    logger.debug(`Initializing Tesseract with ${this.workerCount} workers`);

    try {
      // Create scheduler for parallel processing
      this.scheduler = createScheduler();

      // Create workers in parallel
      // In v5+, createWorker takes (langs, oem, options) directly
      // No separate initialize() or loadLanguage() calls needed
      const workerPromises = Array.from({ length: this.workerCount }, async () => {
        const worker = await createWorker(this.language, 1, {
          // Suppress Tesseract logs in production
          logger: (m) => {
            if (process.env.DEBUG) {
              logger.debug(`Tesseract: ${m.status} ${Math.round((m.progress || 0) * 100)}%`);
            }
          },
        });
        return worker;
      });

      this.workers = await Promise.all(workerPromises);

      // Add workers to scheduler
      for (const worker of this.workers) {
        this.scheduler.addWorker(worker);
      }

      this.initialized = true;
      logger.debug(`Tesseract initialized with ${this.workers.length} workers`);
    } catch (err) {
      await this.shutdown();
      const message = err instanceof Error ? err.message : String(err);
      throw new OcrError(`Failed to initialize Tesseract: ${message}`);
    }
  }

  /**
   * Recognize text from an image file
   */
  async recognize(imagePath: string): Promise<OcrResult> {
    if (!this.initialized || !this.scheduler) {
      await this.initialize();
    }

    const startTime = Date.now();

    try {
      // Preprocess the image for better OCR accuracy
      const { buffer, metadata } = await preprocessImage(imagePath);

      // Run OCR with timeout using scheduler
      const result = await this.recognizeWithTimeout(buffer);

      return {
        text: result.text.trim(),
        confidence: result.confidence,
        width: metadata.width,
        height: metadata.height,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (err) {
      if (err instanceof OcrError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new OcrError(`OCR failed for ${imagePath}: ${message}`, imagePath);
    }
  }

  /**
   * Recognize text from a buffer
   */
  async recognizeBuffer(buffer: Buffer): Promise<OcrResult> {
    if (!this.initialized || !this.scheduler) {
      await this.initialize();
    }

    const startTime = Date.now();

    try {
      // Preprocess the buffer
      const { buffer: processed, metadata } = await preprocessBuffer(buffer);

      // Run OCR with timeout
      const result = await this.recognizeWithTimeout(processed);

      return {
        text: result.text.trim(),
        confidence: result.confidence,
        width: metadata.width,
        height: metadata.height,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (err) {
      if (err instanceof OcrError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new OcrError(`OCR failed: ${message}`);
    }
  }

  /**
   * Run OCR with timeout using scheduler.addJob
   */
  private async recognizeWithTimeout(
    buffer: Buffer
  ): Promise<{ text: string; confidence: number }> {
    if (!this.scheduler) {
      throw new OcrError("Scheduler not initialized");
    }

    // Suppress console noise during OCR (Tesseract prints DPI warnings, system prints msgtracer)
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalStderr = process.stderr.write.bind(process.stderr);

    const isNoise = (msg: string) =>
      msg.includes("resolution") ||
      msg.includes("dpi") ||
      msg.includes("msgtracer") ||
      msg.includes("Context leak") ||
      msg.includes("Warning:");

    console.warn = (...args: unknown[]) => {
      if (isNoise(String(args[0] || ""))) return;
      originalWarn.apply(console, args);
    };
    console.error = (...args: unknown[]) => {
      if (isNoise(String(args[0] || ""))) return;
      originalError.apply(console, args);
    };
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      if (isNoise(String(chunk))) return true;
      return originalStderr(chunk, ...args);
    }) as any;

    return new Promise((resolve, reject) => {
      const restore = () => {
        console.warn = originalWarn;
        console.error = originalError;
        process.stderr.write = originalStderr;
      };

      const timeout = setTimeout(() => {
        restore();
        reject(new OcrError("OCR timeout exceeded"));
      }, OCR_TIMEOUT);

      // Use scheduler.addJob for parallel processing
      this.scheduler!
        .addJob("recognize", buffer)
        .then((result) => {
          clearTimeout(timeout);
          restore();
          resolve({
            text: result.data.text,
            confidence: result.data.confidence,
          });
        })
        .catch((err) => {
          clearTimeout(timeout);
          restore();
          reject(err);
        });
    });
  }

  /**
   * Shutdown the OCR engine and release resources
   */
  async shutdown(): Promise<void> {
    if (this.scheduler) {
      try {
        // scheduler.terminate() terminates all workers
        await this.scheduler.terminate();
      } catch (err) {
        logger.debug(`Error terminating scheduler: ${err}`);
      }
      this.scheduler = null;
    }

    this.workers = [];
    this.initialized = false;
    logger.debug("Tesseract shutdown complete");
  }

  /**
   * Check if the engine is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the number of active workers
   */
  getWorkerCount(): number {
    return this.workers.length;
  }
}

// Singleton instance
let instance: TesseractEngine | null = null;

/**
 * Get the Tesseract engine instance
 */
export function getTesseractEngine(): TesseractEngine {
  if (!instance) {
    instance = new TesseractEngine();
  }
  return instance;
}

/**
 * Initialize the Tesseract engine
 */
export async function initializeTesseract(options?: OcrEngineOptions): Promise<void> {
  const engine = getTesseractEngine();
  await engine.initialize(options);
}

/**
 * Recognize text from an image using Tesseract
 */
export async function recognizeText(imagePath: string): Promise<OcrResult> {
  const engine = getTesseractEngine();
  return engine.recognize(imagePath);
}

/**
 * Recognize text from a buffer using Tesseract
 */
export async function recognizeBuffer(buffer: Buffer): Promise<OcrResult> {
  const engine = getTesseractEngine();
  return engine.recognizeBuffer(buffer);
}

/**
 * Shutdown Tesseract and release resources
 */
export async function shutdownTesseract(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}

export { TesseractEngine };
export default getTesseractEngine;
