/**
 * Memvid SDK wrapper for screenshot-memory
 * Handles all interactions with the memory file
 */

import { create, open, type Memvid } from "@memvid/sdk";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig, ensureDir, logger, MemoryError, MemoryNotInitializedError } from "../utils/index.js";

// Singleton instance
let memoryInstance: Memvid | null = null;
let currentPath: string | null = null;

/**
 * Initialize or get the memory instance
 */
export async function getMemory(options?: {
  create?: boolean;
  path?: string;
}): Promise<Memvid> {
  const config = getConfig();
  const memoryPath = options?.path || config.memoryPath;

  // Return existing instance if same path
  if (memoryInstance && currentPath === memoryPath) {
    return memoryInstance;
  }

  // Close existing instance if different path
  if (memoryInstance && currentPath !== memoryPath) {
    await closeMemory();
  }

  // Check if memory file exists
  const exists = existsSync(memoryPath);

  if (!exists && !options?.create) {
    throw new MemoryNotInitializedError();
  }

  try {
    // Ensure directory exists
    const dir = dirname(memoryPath);
    ensureDir(dir);

    // Open or create memory
    if (exists) {
      logger.debug(`Opening memory: ${memoryPath}`);
      memoryInstance = await open(memoryPath);
    } else {
      logger.debug(`Creating memory: ${memoryPath}`);
      memoryInstance = await create(memoryPath);
    }

    currentPath = memoryPath;
    return memoryInstance;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Handle specific memvid errors
    if (message.includes("MV007") || message.includes("locked")) {
      throw new MemoryError(
        "Memory file is locked by another process.",
        "Close other instances or wait and try again."
      );
    }

    if (message.includes("MV012") || message.includes("corrupt")) {
      throw new MemoryError(
        "Memory file is corrupted.",
        "Try running 'ssm doctor' to repair, or delete and re-index."
      );
    }

    throw new MemoryError(`Failed to open memory: ${message}`);
  }
}

/**
 * Create a new memory (will overwrite if exists)
 */
export async function createMemory(path?: string): Promise<Memvid> {
  const config = getConfig();
  const memoryPath = path || config.memoryPath;

  // Close existing instance
  if (memoryInstance) {
    await closeMemory();
  }

  try {
    // Ensure directory exists
    const dir = dirname(memoryPath);
    ensureDir(dir);

    logger.debug(`Creating new memory: ${memoryPath}`);
    memoryInstance = await create(memoryPath);
    currentPath = memoryPath;
    return memoryInstance;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MemoryError(`Failed to create memory: ${message}`);
  }
}

/**
 * Close the memory instance
 */
export async function closeMemory(): Promise<void> {
  if (memoryInstance) {
    try {
      logger.debug("Closing memory instance");
      // The SDK handles cleanup internally
      memoryInstance = null;
      currentPath = null;
    } catch (err) {
      logger.debug(`Error closing memory: ${err}`);
    }
  }
}

/**
 * Check if memory exists
 */
export function memoryExists(path?: string): boolean {
  const config = getConfig();
  const memoryPath = path || config.memoryPath;
  return existsSync(memoryPath);
}

/**
 * Get memory statistics
 */
export async function getMemoryStats(path?: string): Promise<{
  frameCount: number;
  usedBytes: number;
  capacity: number;
  compressionRatio: number;
  hasLexIndex: boolean;
  hasVecIndex: boolean;
}> {
  const mv = await getMemory({ path });
  const stats = await mv.stats();

  return {
    frameCount: stats.frame_count ?? 0,
    usedBytes: stats.size_bytes ?? 0,
    capacity: stats.capacity_bytes ?? 0,
    compressionRatio: stats.compression_ratio_percent ?? 0,
    hasLexIndex: stats.has_lex_index ?? false,
    hasVecIndex: stats.has_vec_index ?? false,
  };
}

/**
 * Get memory path
 */
export function getMemoryPath(): string {
  const config = getConfig();
  return config.memoryPath;
}

/**
 * Get the current memory instance (or null)
 */
export function getCurrentMemory(): Memvid | null {
  return memoryInstance;
}

// Export for advanced usage
export { type Memvid };
