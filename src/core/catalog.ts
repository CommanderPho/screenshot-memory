/**
 * Index Catalog module for screenshot-memory
 * Tracks indexed screenshots to prevent redundant re-indexing
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath, ensureDir, logger } from "../utils/index.js";

export interface CatalogEntry {
  /** Normalized absolute path of the image */
  path: string;
  /** File modification timestamp in ms */
  mtimeMs: number;
  /** File size in bytes */
  size: number;
  /** Timestamp when the file was indexed */
  indexedAt: number;
  /** Indexing outcome: indexed (has text/caption), empty (valid image but no text), or failed */
  status: "indexed" | "empty" | "failed";
}

export interface CatalogData {
  version: number;
  updatedAt: number;
  entries: Record<string, CatalogEntry>;
}

const CATALOG_VERSION = 1;

/**
 * Get manifest file path for a given memory file path
 */
export function getManifestPath(memoryPath: string): string {
  const resolved = resolvePath(memoryPath);
  return `${resolved}.manifest.json`;
}

/**
 * In-memory representation of the index catalog
 */
export class IndexCatalog {
  private entries: Map<string, CatalogEntry>;
  private isDirty = false;

  constructor(
    public readonly manifestPath: string,
    initialEntries?: Record<string, CatalogEntry>
  ) {
    this.entries = new Map();
    if (initialEntries) {
      for (const [key, value] of Object.entries(initialEntries)) {
        this.entries.set(resolvePath(key), value);
      }
    }
  }

  /**
   * Check if a file is already indexed and unchanged
   */
  isUpToDate(filePath: string, stat: { mtimeMs: number; size: number }): boolean {
    const key = resolvePath(filePath);
    const existing = this.entries.get(key);
    if (!existing) return false;

    // Both mtime and size must match for it to be considered unchanged
    return (
      Math.abs(existing.mtimeMs - stat.mtimeMs) < 1000 &&
      existing.size === stat.size &&
      existing.status !== "failed"
    );
  }

  /**
   * Get entry for a file
   */
  get(filePath: string): CatalogEntry | undefined {
    return this.entries.get(resolvePath(filePath));
  }

  /**
   * Record a file indexing result
   */
  record(
    filePath: string,
    stat: { mtimeMs: number; size: number },
    status: CatalogEntry["status"]
  ): void {
    const key = resolvePath(filePath);
    this.entries.set(key, {
      path: key,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      indexedAt: Date.now(),
      status,
    });
    this.isDirty = true;
  }

  /**
   * Remove a file from catalog
   */
  remove(filePath: string): boolean {
    const key = resolvePath(filePath);
    const removed = this.entries.delete(key);
    if (removed) this.isDirty = true;
    return removed;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries.clear();
    this.isDirty = true;
  }

  /**
   * Get total number of entries
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Check if catalog has unsaved changes
   */
  get dirty(): boolean {
    return this.isDirty;
  }

  /**
   * Save catalog atomically to disk
   */
  save(): void {
    const dir = dirname(this.manifestPath);
    ensureDir(dir);

    const data: CatalogData = {
      version: CATALOG_VERSION,
      updatedAt: Date.now(),
      entries: Object.fromEntries(this.entries),
    };

    const serialized = JSON.stringify(data, null, 2);
    const tmpPath = `${this.manifestPath}.tmp.${Date.now()}`;

    try {
      writeFileSync(tmpPath, serialized, "utf-8");
      renameSync(tmpPath, this.manifestPath);
      this.isDirty = false;
    } catch (err) {
      if (existsSync(tmpPath)) {
        try { unlinkSync(tmpPath); } catch {}
      }
      logger.debug(`Failed to save manifest to ${this.manifestPath}: ${err}`);
      throw err;
    }
  }
}

/**
 * Load index catalog for a given memory path
 */
export async function loadCatalog(memoryPath: string): Promise<IndexCatalog> {
  const manifestPath = getManifestPath(memoryPath);

  if (!existsSync(manifestPath)) {
    return new IndexCatalog(manifestPath);
  }

  try {
    const content = readFileSync(manifestPath, "utf-8");
    const data = JSON.parse(content) as CatalogData;

    if (data && typeof data.entries === "object") {
      return new IndexCatalog(manifestPath, data.entries);
    }
  } catch (err) {
    logger.debug(`Could not read manifest at ${manifestPath}: ${err}`);
  }

  return new IndexCatalog(manifestPath);
}

/**
 * Clear the manifest file for a memory path
 */
export function clearCatalog(memoryPath: string): void {
  const manifestPath = getManifestPath(memoryPath);
  if (existsSync(manifestPath)) {
    try {
      unlinkSync(manifestPath);
    } catch (err) {
      logger.debug(`Failed to remove manifest at ${manifestPath}: ${err}`);
    }
  }
}
