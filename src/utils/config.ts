/**
 * Configuration management for screenshot-memory
 */

import Conf from "conf";
import { DEFAULT_CONFIG, APP_NAME } from "./constants.js";
import { getDefaultMemoryPath, getDefaultScreenshotDirs, resolvePath } from "./paths.js";

export interface OcrConfig {
  workers: number;
  language: string;
  engine: "tesseract" | "paddle";
}

export interface SearchConfig {
  defaultMode: "lex" | "sem" | "auto";
  defaultLimit: number;
  minRelevancy: number;
  snippetChars: number;
}

export interface DisplayConfig {
  imagePreview: boolean;
  previewWidth: number;
  previewHeight: number;
}

export interface IndexingConfig {
  batchSize: number;
  compressionLevel: number;
  embeddingModel: string;
  /** Keep OCR text in the local SQLite search index. */
  ocrBackup: boolean;
}

export interface AppConfig {
  directories: string[];
  memoryPath: string;
  ocr: OcrConfig;
  search: SearchConfig;
  display: DisplayConfig;
  indexing: IndexingConfig;
}

// Schema for validation
const schema = {
  directories: {
    type: "array" as const,
    items: { type: "string" as const },
    default: [] as string[],
  },
  memoryPath: {
    type: "string" as const,
    default: "",
  },
  ocr: {
    type: "object" as const,
    properties: {
      workers: { type: "number" as const, default: DEFAULT_CONFIG.ocr.workers },
      language: { type: "string" as const, default: DEFAULT_CONFIG.ocr.language },
      engine: { type: "string" as const, default: DEFAULT_CONFIG.ocr.engine },
    },
    default: DEFAULT_CONFIG.ocr,
  },
  search: {
    type: "object" as const,
    properties: {
      defaultMode: { type: "string" as const, default: DEFAULT_CONFIG.search.defaultMode },
      defaultLimit: { type: "number" as const, default: DEFAULT_CONFIG.search.defaultLimit },
      minRelevancy: { type: "number" as const, default: DEFAULT_CONFIG.search.minRelevancy },
      snippetChars: { type: "number" as const, default: DEFAULT_CONFIG.search.snippetChars },
    },
    default: DEFAULT_CONFIG.search,
  },
  display: {
    type: "object" as const,
    properties: {
      imagePreview: { type: "boolean" as const, default: DEFAULT_CONFIG.display.imagePreview },
      previewWidth: { type: "number" as const, default: DEFAULT_CONFIG.display.previewWidth },
      previewHeight: { type: "number" as const, default: DEFAULT_CONFIG.display.previewHeight },
    },
    default: DEFAULT_CONFIG.display,
  },
  indexing: {
    type: "object" as const,
    properties: {
      batchSize: { type: "number" as const, default: DEFAULT_CONFIG.indexing.batchSize },
      compressionLevel: { type: "number" as const, default: DEFAULT_CONFIG.indexing.compressionLevel },
      embeddingModel: { type: "string" as const, default: DEFAULT_CONFIG.indexing.embeddingModel },
      ocrBackup: { type: "boolean" as const, default: DEFAULT_CONFIG.indexing.ocrBackup },
    },
    default: DEFAULT_CONFIG.indexing,
  },
};

// Initialize config store
const store = new Conf<Partial<AppConfig>>({
  projectName: APP_NAME,
  schema,
  defaults: {},
});

/**
 * Get the full configuration with defaults
 */
export function getConfig(): AppConfig {
  const stored = store.store;

  return {
    directories: stored.directories?.length
      ? stored.directories.map(resolvePath)
      : getDefaultScreenshotDirs(),
    memoryPath: stored.memoryPath
      ? resolvePath(stored.memoryPath)
      : getDefaultMemoryPath(),
    ocr: {
      ...DEFAULT_CONFIG.ocr,
      ...stored.ocr,
    },
    search: {
      ...DEFAULT_CONFIG.search,
      ...stored.search,
    },
    display: {
      ...DEFAULT_CONFIG.display,
      ...stored.display,
    },
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      ...stored.indexing,
    },
  };
}

/**
 * Get a specific config value
 */
export function get<K extends keyof AppConfig>(key: K): AppConfig[K] {
  return getConfig()[key];
}

/**
 * Set a config value
 */
export function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  store.set(key, value);
}

/**
 * Set the memory path
 */
export function setMemoryPath(path: string): void {
  store.set("memoryPath", resolvePath(path));
}

/**
 * Set the screenshot directories
 */
export function setDirectories(dirs: string[]): void {
  store.set("directories", dirs.map(resolvePath));
}

/**
 * Add a screenshot directory
 */
export function addDirectory(dir: string): void {
  const current = store.get("directories") || [];
  const resolved = resolvePath(dir);
  if (!current.includes(resolved)) {
    store.set("directories", [...current, resolved]);
  }
}

/**
 * Reset config to defaults
 */
export function reset(): void {
  store.clear();
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return store.path;
}

/**
 * Export config object for direct manipulation
 */
export const config = {
  get: getConfig,
  getValue: get,
  set,
  setMemoryPath,
  setDirectories,
  addDirectory,
  reset,
  path: getConfigPath,
};

export default config;
