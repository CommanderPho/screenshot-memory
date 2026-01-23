/**
 * Path utilities for screenshot-memory
 */

import envPaths from "env-paths";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { APP_NAME, MEMORY_FILE_NAME } from "./constants.js";

// Get platform-specific paths
const paths = envPaths(APP_NAME, { suffix: "" });

/**
 * Get the data directory (where we store the memory file)
 */
export function getDataDir(): string {
  const dir = paths.data;
  ensureDir(dir);
  return dir;
}

/**
 * Get the config directory
 */
export function getConfigDir(): string {
  const dir = paths.config;
  ensureDir(dir);
  return dir;
}

/**
 * Get the cache directory
 */
export function getCacheDir(): string {
  const dir = paths.cache;
  ensureDir(dir);
  return dir;
}

/**
 * Get the default memory file path
 */
export function getDefaultMemoryPath(): string {
  return join(getDataDir(), MEMORY_FILE_NAME);
}

/**
 * Get default screenshot directories based on platform
 */
export function getDefaultScreenshotDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];

  if (process.platform === "darwin") {
    // macOS
    dirs.push(
      join(home, "Desktop"),
      join(home, "Desktop", "Screenshots"),
      join(home, "Pictures", "Screenshots"),
      join(home, "Documents", "Screenshots"),
    );
  } else if (process.platform === "win32") {
    // Windows
    dirs.push(
      join(home, "Pictures", "Screenshots"),
      join(home, "Desktop"),
      join(home, "OneDrive", "Pictures", "Screenshots"),
    );
  } else {
    // Linux
    dirs.push(
      join(home, "Pictures", "Screenshots"),
      join(home, "Pictures"),
      join(home, "Desktop"),
    );
  }

  // Return only directories that exist
  return dirs.filter((dir) => existsSync(dir));
}

/**
 * Detect screenshot directory with most images
 */
export function detectScreenshotDir(): string | null {
  const dirs = getDefaultScreenshotDirs();

  // Just return the first existing directory
  // The actual counting will be done when indexing
  return dirs.length > 0 ? dirs[0] : null;
}

/**
 * Expand ~ to home directory
 */
export function expandPath(inputPath: string): string {
  if (inputPath.startsWith("~")) {
    return join(homedir(), inputPath.slice(1));
  }
  return inputPath;
}

/**
 * Resolve path to absolute
 */
export function resolvePath(inputPath: string): string {
  const expanded = expandPath(inputPath);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/**
 * Ensure directory exists
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Check if path is a supported image
 */
export function isSupportedImage(filePath: string): boolean {
  const ext = filePath.toLowerCase();
  return (
    ext.endsWith(".png") ||
    ext.endsWith(".jpg") ||
    ext.endsWith(".jpeg") ||
    ext.endsWith(".webp") ||
    ext.endsWith(".bmp") ||
    ext.endsWith(".tiff") ||
    ext.endsWith(".tif")
  );
}
