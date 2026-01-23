/**
 * Watch command - Watch for new screenshots and auto-index
 */

import chalk from "chalk";
import chokidar from "chokidar";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { indexSingleImage } from "../core/indexer.js";
import { initializeOcr, shutdownOcr } from "../ocr/index.js";
import {
  getConfig,
  resolvePath,
  getDefaultScreenshotDirs,
  isSupportedImage,
  logger,
  formatError,
} from "../utils/index.js";

export interface WatchCommandOptions {
  daemon?: boolean;
}

// Track if watcher is running
let isWatching = false;
let watcher: chokidar.FSWatcher | null = null;

/**
 * Execute the watch command
 */
export async function watchCommand(
  pathArg: string | undefined,
  options: WatchCommandOptions
): Promise<void> {
  const config = getConfig();

  // Determine directory to watch
  let directory: string;

  if (pathArg) {
    directory = resolvePath(pathArg);
  } else if (config.directories.length > 0) {
    directory = config.directories[0];
  } else {
    const detected = getDefaultScreenshotDirs();
    if (detected.length > 0) {
      directory = detected[0];
    } else {
      logger.error("No screenshot directory specified or detected.");
      logger.log(chalk.gray("  Usage: ssm watch <directory>"));
      logger.log(chalk.gray("  Example: ssm watch ~/Screenshots"));
      process.exit(1);
    }
  }

  // Validate directory
  if (!existsSync(directory)) {
    logger.error(`Directory not found: ${directory}`);
    process.exit(1);
  }

  // Header
  console.log();
  console.log(chalk.bold.cyan("📸 screenshot-memory"));
  console.log(chalk.gray(`   Watching: ${directory}`));
  console.log();

  // Initialize OCR with single worker for watch mode
  try {
    await initializeOcr({ workers: 1 });
  } catch (err) {
    const { message } = formatError(err);
    logger.error(`Failed to initialize OCR: ${message}`);
    process.exit(1);
  }

  // Set up file watcher
  isWatching = true;
  let indexingCount = 0;

  watcher = chokidar.watch(directory, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
    ignored: [
      /(^|[\/\\])\../,  // Ignore dotfiles
      /node_modules/,
      /\.DS_Store/,
    ],
  });

  // Handle new files
  watcher.on("add", async (filePath: string) => {
    // Only process supported images
    if (!isSupportedImage(filePath)) {
      return;
    }

    const filename = basename(filePath);
    const timestamp = new Date().toLocaleTimeString();

    indexingCount++;
    logger.log(chalk.gray(`[${timestamp}]`) + chalk.yellow(` 📷 New: ${filename}`));

    try {
      const indexed = await indexSingleImage(filePath);

      if (indexed) {
        logger.log(
          chalk.gray(`[${timestamp}]`) +
          chalk.green(` ✅ Indexed: ${filename}`)
        );
      } else {
        logger.log(
          chalk.gray(`[${timestamp}]`) +
          chalk.gray(` ⏭️  Skipped: ${filename} (no text)`)
        );
      }
    } catch (err) {
      const { message } = formatError(err);
      logger.log(
        chalk.gray(`[${timestamp}]`) +
        chalk.red(` ❌ Failed: ${filename}: ${message}`)
      );
    }

    indexingCount--;
  });

  // Handle errors
  watcher.on("error", (error: Error) => {
    logger.error(`Watcher error: ${error.message}`);
  });

  // Handle ready
  watcher.on("ready", () => {
    console.log(chalk.green("👀 Watching for new screenshots..."));
    console.log(chalk.gray("   Press Ctrl+C to stop."));
    console.log();
  });

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    if (!isWatching) return;
    isWatching = false;

    console.log();
    logger.log(chalk.gray(`Received ${signal}, shutting down...`));

    // Wait for any in-progress indexing
    while (indexingCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Close watcher
    if (watcher) {
      await watcher.close();
      watcher = null;
    }

    // Shutdown OCR
    await shutdownOcr();

    logger.success("Watch stopped.");
    process.exit(0);
  };

  // Register signal handlers
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep process alive
  if (!options.daemon) {
    // In foreground mode, just wait
    await new Promise(() => {});
  } else {
    // In daemon mode, we would typically fork the process
    // For simplicity, we just run in the foreground
    logger.log(chalk.gray("Running in foreground (daemon mode not fully implemented)"));
    await new Promise(() => {});
  }
}

/**
 * Stop watching (for external control)
 */
export async function stopWatch(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  isWatching = false;
  await shutdownOcr();
}

/**
 * Check if watcher is running
 */
export function isWatcherRunning(): boolean {
  return isWatching;
}
