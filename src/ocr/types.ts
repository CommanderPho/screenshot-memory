/**
 * OCR types and interfaces
 */

export interface OcrResult {
  text: string;
  confidence: number;
  width: number;
  height: number;
  processingTimeMs: number;
}

export interface OcrEngine {
  name: string;
  initialize(options?: OcrEngineOptions): Promise<void>;
  recognize(imagePath: string): Promise<OcrResult>;
  recognizeBuffer(buffer: Buffer): Promise<OcrResult>;
  shutdown(): Promise<void>;
  isInitialized(): boolean;
}

export interface OcrEngineOptions {
  workers?: number;
  language?: string;
  timeout?: number;
}

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  size: number;
}

export interface PreprocessedImage {
  buffer: Buffer;
  metadata: ImageMetadata;
}
