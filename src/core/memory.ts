/**
 * Local SQLite index location and statistics.
 */

import { getConfig } from "../utils/index.js";
import { ocrBackupPath } from "./ocr-backup.js";
import { SearchStore } from "./search-store.js";
import { existsSync } from "node:fs";

export function memoryExists(path?: string): boolean {
  return existsSync(indexFilePath(path));
}

export function getMemoryPath(): string {
  return indexFilePath();
}

export async function getMemoryStats(path?: string): Promise<{
  frameCount: number;
  usedBytes: number;
  capacity: number;
  compressionRatio: number;
  hasLexIndex: boolean;
  hasVecIndex: boolean;
  memoryPath: string;
}> {
  const memoryPath = indexFilePath(path);
  if (!existsSync(memoryPath)) {
    return {
      frameCount: 0,
      usedBytes: 0,
      capacity: 0,
      compressionRatio: 0,
      hasLexIndex: false,
      hasVecIndex: false,
      memoryPath,
    };
  }

  const store = await SearchStore.open(path || getConfig().memoryPath);
  try {
    const stats = store.stats();
    return {
      frameCount: stats.documentCount,
      usedBytes: stats.indexSizeBytes,
      capacity: 0,
      compressionRatio: 0,
      hasLexIndex: stats.hasLexIndex,
      hasVecIndex: stats.hasVecIndex,
      memoryPath: stats.memoryPath,
    };
  } finally {
    store.close();
  }
}

function indexFilePath(path?: string): string {
  const config = getConfig();
  return ocrBackupPath(path || config.memoryPath);
}
