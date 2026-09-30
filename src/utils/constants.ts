/**
 * Application constants
 */

export const APP_NAME = "screenshot-memory";
export const APP_VERSION = "1.0.0";

// File extensions we support
export const SUPPORTED_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
] as const;

export const SUPPORTED_EXTENSIONS_GLOB = "*.{png,jpg,jpeg,webp,bmp,tiff,tif,PNG,JPG,JPEG,WEBP,BMP,TIFF,TIF}";

// Default configuration
export const DEFAULT_CONFIG = {
  // OCR settings
  ocr: {
    workers: 4,
    language: "eng",
    engine: "tesseract" as const,
  },

  // Search settings
  search: {
    defaultMode: "auto" as const,
    defaultLimit: 5,
    minRelevancy: 0.3,
    snippetChars: 200,
  },

  // Display settings
  display: {
    imagePreview: true,
    previewWidth: 50,
    previewHeight: 15,
  },

  // Indexing settings
  indexing: {
    batchSize: 100,
    compressionLevel: 3,
    embeddingModel: "nomic-embed-text" as const,
  },
} as const;

// Memory file settings
export const MEMORY_FILE_NAME = "screenshots.mv2";

// Performance limits
export const MAX_IMAGE_DIMENSION = 3000; // Max width/height for OCR
export const MIN_TEXT_LENGTH = 3; // Minimum OCR text length to index
export const MAX_CONCURRENT_OCR = 8; // Maximum parallel OCR workers
export const BATCH_INSERT_SIZE = 50; // Documents per putMany batch

// Timeouts (ms)
export const OCR_TIMEOUT = 30000; // 30 seconds per image
export const SEARCH_TIMEOUT = 10000; // 10 seconds for search

// Labels
export const DOCUMENT_LABEL = "screenshot";
