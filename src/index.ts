/**
 * screenshot-memory
 * Find any screenshot by what's IN it.
 *
 * @packageDocumentation
 */

// Core functionality
export {
  memoryExists,
  getMemoryStats,
  getMemoryPath,
} from "./core/memory.js";

export {
  // Indexing
  indexDirectory,
  indexSingleImage,
  getIndexStats,
  type IndexOptions,
  type IndexProgress,
  type IndexResult,
} from "./core/indexer.js";

export {
  // Search
  search,
  searchWithContext,
  hasMatches,
  type SearchOptions,
  type SearchResult,
  type SearchHit,
  type SearchMode,
} from "./core/searcher.js";

// OCR
export {
  initializeOcr,
  processImage,
  processImages,
  shutdownOcr,
  isOcrInitialized,
  getOcrEngineName,
  setOcrWarningHandler,
  resetOcrWarningDedupe,
  type OcrResult,
  type OcrEngineOptions,
} from "./ocr/index.js";

// Display
export {
  displayImage,
  displayResults,
  openImage,
  supportsImageDisplay,
  getDisplayMethodDescription,
} from "./display/index.js";

// Utilities
export {
  getConfig,
  setMemoryPath,
  setDirectories,
  addDirectory,
  config,
  type AppConfig,
} from "./utils/config.js";

export {
  getDefaultScreenshotDirs,
  detectScreenshotDir,
  resolvePath,
  expandPath,
  isSupportedImage,
} from "./utils/paths.js";

export {
  logger,
  setLogLevel,
  type LogLevel,
} from "./utils/logger.js";

export {
  ScreenshotMemoryError,
  OcrError,
  SearchError,
  IndexError,
  MemoryError,
  formatError,
} from "./utils/errors.js";

// Constants
export {
  APP_NAME,
  APP_VERSION,
  SUPPORTED_EXTENSIONS,
} from "./utils/constants.js";
