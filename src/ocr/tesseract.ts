/**
 * Tesseract.js OCR engine with a worker pool.
 * Each job is pinned to one worker so stderr lines can be tied to a file.
 */

import "./capture-worker-stderr.js";
import { createWorker, type Worker } from "tesseract.js";
import { preprocessImage, preprocessBuffer } from "./preprocess.js";
import { getCaptureWorkerPath, onWorkerLine } from "./capture-worker-stderr.js";
import { formatOcrWarning, isBenignOcrNoise } from "./ocr-warnings.js";
import { OcrError, logger } from "../utils/index.js";
import { OCR_TIMEOUT, DEFAULT_CONFIG } from "../utils/constants.js";
import type { OcrEngine, OcrResult, OcrEngineOptions } from "./types.js";

type TessWorker = Worker & { worker?: object };

export type OcrWarningHandler = (imagePath: string, message: string) => void;

class TesseractEngine implements OcrEngine {
  public readonly name = "tesseract";

  private workers: TessWorker[] = [];
  private idle: TessWorker[] = [];
  private waiters: Array<(worker: TessWorker) => void> = [];
  private activePaths = new WeakMap<object, string>();
  private seenWarnings = new Set<string>();
  private warningHandler: OcrWarningHandler | null = null;
  private initialized = false;
  private workerCount: number = DEFAULT_CONFIG.ocr.workers;
  private language: string = DEFAULT_CONFIG.ocr.language;

  /**
   * Initialize the OCR engine with a worker pool
   */
  async initialize(options?: OcrEngineOptions): Promise<void> {
    const targetWorkers = options?.workers || DEFAULT_CONFIG.ocr.workers;
    const targetLanguage = options?.language || DEFAULT_CONFIG.ocr.language;

    if (this.initialized) {
      if (this.workerCount === targetWorkers && this.language === targetLanguage) {
        return;
      }
      logger.debug(`Re-initializing Tesseract with ${targetWorkers} workers (was ${this.workerCount})`);
      await this.shutdown();
    }

    this.workerCount = targetWorkers;
    this.language = targetLanguage;

    logger.debug(`Initializing Tesseract with ${this.workerCount} workers`);

    try {
      const workerPath = getCaptureWorkerPath();
      const workerPromises = Array.from({ length: this.workerCount }, async () => {
        const worker = await createWorker(this.language, 1, {
          workerPath,
          logger: (m) => {
            if (process.env.DEBUG) {
              logger.debug(`Tesseract: ${m.status} ${Math.round((m.progress || 0) * 100)}%`);
            }
          },
        });
        return worker as TessWorker;
      });

      this.workers = await Promise.all(workerPromises);
      this.idle = [...this.workers];
      this.initialized = true;
      logger.debug(`Tesseract initialized with ${this.workers.length} workers`);
    } catch (err) {
      await this.shutdown();
      const message = err instanceof Error ? err.message : String(err);
      throw new OcrError(`Failed to initialize Tesseract: ${message}`);
    }
  }

  setWarningHandler(handler: OcrWarningHandler | null): void {
    this.warningHandler = handler;
  }

  resetWarnings(): void {
    this.seenWarnings.clear();
  }

  /**
   * Attribute a captured worker line to the file that worker is processing.
   */
  handleWorkerLine(nodeWorker: object, line: string): void {
    const imagePath = this.activePaths.get(nodeWorker);
    if (!imagePath) return;

    const message = formatOcrWarning(line);
    if (!message) {
      if (!isBenignOcrNoise(line)) {
        logger.debug(`tesseract: ${line.trim()}`);
      }
      return;
    }

    const key = `${imagePath}\0${message}`;
    if (this.seenWarnings.has(key)) return;
    this.seenWarnings.add(key);
    this.warningHandler?.(imagePath, message);
  }

  /**
   * Recognize text from an image file
   */
  async recognize(imagePath: string): Promise<OcrResult> {
    if (!this.initialized || this.workers.length === 0) {
      await this.initialize();
    }

    const startTime = Date.now();

    try {
      const { buffer, metadata } = await preprocessImage(imagePath);
      const result = await this.recognizeWithTimeout(buffer, imagePath);

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
    if (!this.initialized || this.workers.length === 0) {
      await this.initialize();
    }

    const startTime = Date.now();

    try {
      const { buffer: processed, metadata } = await preprocessBuffer(buffer);
      const result = await this.recognizeWithTimeout(processed, "");

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
   * Run OCR on one pinned worker, with a timeout.
   */
  private async recognizeWithTimeout(
    buffer: Buffer,
    imagePath: string
  ): Promise<{ text: string; confidence: number }> {
    const worker = await this.acquire();
    const nodeWorker = worker.worker;
    if (nodeWorker && imagePath) {
      this.activePaths.set(nodeWorker, imagePath);
    }

    try {
      const result = await new Promise<{ text: string; confidence: number }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new OcrError("OCR timeout exceeded"));
        }, OCR_TIMEOUT);

        worker
          .recognize(buffer)
          .then((recognized) => {
            clearTimeout(timeout);
            resolve({
              text: recognized.data.text,
              confidence: recognized.data.confidence,
            });
          })
          .catch((err: unknown) => {
            clearTimeout(timeout);
            reject(err);
          });
      });
      return result;
    } finally {
      await new Promise((resolve) => setImmediate(resolve));
      if (nodeWorker) {
        this.activePaths.delete(nodeWorker);
      }
      this.release(worker);
    }
  }

  private acquire(): Promise<TessWorker> {
    const worker = this.idle.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(worker: TessWorker): void {
    const next = this.waiters.shift();
    if (next) {
      next(worker);
    } else {
      this.idle.push(worker);
    }
  }

  /**
   * Shutdown the OCR engine and release resources
   */
  async shutdown(): Promise<void> {
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    this.waiters = [];
    this.initialized = false;

    await Promise.all(
      workers.map(async (worker) => {
        try {
          await worker.terminate();
        } catch (err) {
          logger.debug(`Error terminating worker: ${err}`);
        }
      })
    );

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

onWorkerLine((nodeWorker, line) => {
  getTesseractEngine().handleWorkerLine(nodeWorker, line);
});

/**
 * Initialize the Tesseract engine
 */
export async function initializeTesseract(options?: OcrEngineOptions): Promise<void> {
  const engine = getTesseractEngine();
  await engine.initialize(options);
}

/**
 * Receive one deduped warning per file and message while OCR is running.
 */
export function setOcrWarningHandler(handler: OcrWarningHandler | null): void {
  getTesseractEngine().setWarningHandler(handler);
}

/**
 * Allow the same file to report warnings again on a later index run.
 */
export function resetOcrWarningDedupe(): void {
  getTesseractEngine().resetWarnings();
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
