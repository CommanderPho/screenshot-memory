/**
 * Index command - Index screenshots from a directory
 */

import chalk from "chalk";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { indexDirectory, indexSingleImage, type IndexProgress, type IndexResult } from "../core/indexer.js";
import { ProgressTracker, formatBytes, formatDuration, formatNumber } from "../display/progress.js";
import {
  getConfig,
  resolvePath,
  getDefaultScreenshotDirs,
  logger,
  formatError,
} from "../utils/index.js";

export interface IndexCommandOptions {
  workers?: string;
  force?: boolean;
  quiet?: boolean;
  caption?: boolean;
}

/**
 * Execute the index command
 */
export async function indexCommand(
  pathArg: string | undefined,
  options: IndexCommandOptions
): Promise<void> {
  const config = getConfig();

  // Determine directory to index
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
      logger.log(chalk.gray("  Usage: ssm index <directory>"));
      logger.log(chalk.gray("  Example: ssm index ~/Screenshots"));
      process.exit(1);
    }
  }

  // Validate path exists
  if (!existsSync(directory)) {
    logger.error(`Path not found: ${directory}`);
    process.exit(1);
  }

  // Check if it's a single file
  const pathStats = statSync(directory);
  if (pathStats.isFile()) {
    await indexSingleFile(directory, options);
    return;
  }

  // Parse options
  const workers = options.workers ? parseInt(options.workers, 10) : config.ocr.workers;

  // Header
  if (!options.quiet) {
    console.log();
    console.log(chalk.bold.cyan("📸 screenshot-memory"));
    console.log(chalk.white(`   Directory: `) + chalk.cyan(directory));
    console.log(
      chalk.white(`   Mode:      `) +
      chalk.gray(options.force ? "Force re-index" : "Incremental") +
      chalk.white(` · Workers: `) +
      chalk.cyan(String(workers)) +
      (options.caption !== undefined
        ? chalk.white(` · Vision: `) + chalk.gray(options.caption ? "enabled" : "disabled")
        : "")
    );
    console.log();
  }

  // Create progress tracker
  const progress = new ProgressTracker();
  let lastPhase: IndexProgress["phase"] | null = null;

  try {
    const result = await indexDirectory({
      directory,
      force: options.force,
      workers,
      caption: options.caption,
      onProgress: (p: IndexProgress) => {
        if (options.quiet) return;

        // Handle phase transitions
        if (p.phase !== lastPhase) {
          if (lastPhase) {
            progress.succeed();
          }

          switch (p.phase) {
            case "scanning":
              progress.startPhase("scanning", "Scanning for screenshots...");
              break;
            case "ocr": {
              const skipMsg =
                p.alreadyIndexed && p.alreadyIndexed > 0
                  ? chalk.dim(` (${formatNumber(p.alreadyIndexed)} already indexed, ${formatNumber(p.total)} to process)`)
                  : "";
              progress.startProgressPhase(
                "ocr",
                p.total,
                `Processing ${formatNumber(p.total)} screenshots...${skipMsg}`
              );
              break;
            }
            case "indexing":
              progress.startProgressPhase(
                "indexing",
                p.total,
                `Storing ${formatNumber(p.total)} documents...`
              );
              break;
            case "finalizing":
              progress.startPhase("finalizing", p.message || "Optimizing index...");
              break;
          }
          lastPhase = p.phase;
        }

        // Update progress
        if (p.phase === "ocr" || p.phase === "indexing") {
          progress.update(p.current, {
            filename: p.currentFile ? basename(p.currentFile) : "",
            workerCount: p.workerCount || workers,
            activeCount: p.activeCount,
            indexed: p.indexed,
            skipped: p.skipped,
            failed: p.failed,
          });
        }
      },
      onFileError: (path: string, error: Error) => {
        if (!options.quiet) {
          logger.debug(`Failed: ${basename(path)}: ${error.message}`);
        }
      },
    });

    // Complete progress
    progress.succeed();

    // Display results
    if (!options.quiet) {
      displayIndexResult(result);
    }
  } catch (err) {
    progress.fail();
    const { message, suggestion } = formatError(err);
    logger.error(message);
    if (suggestion) {
      logger.log(chalk.gray(`  ${suggestion}`));
    }
    process.exit(1);
  }
}

/**
 * Display index results
 */
function displayIndexResult(result: IndexResult): void {
  const avgRate =
    result.timeMs > 0 && result.indexed > 0
      ? (result.indexed / (result.timeMs / 1000)).toFixed(1)
      : undefined;

  console.log();
  console.log(chalk.green.bold("✅ Indexing complete!"));
  console.log();
  console.log(chalk.white.bold("   Summary"));
  console.log(chalk.white(`   Total found:     `) + chalk.cyan(`${formatNumber(result.totalFound)} screenshots`));
  if (result.alreadyIndexed !== undefined && result.alreadyIndexed > 0) {
    console.log(chalk.white(`   Already indexed: `) + chalk.green(`${formatNumber(result.alreadyIndexed)}`) + chalk.dim(` (skipped)`));
  }
  console.log(chalk.white(`   Newly indexed:   `) + chalk.cyan(`${formatNumber(result.indexed)} screenshots`));
  const otherSkipped = result.skipped - (result.alreadyIndexed || 0);
  if (otherSkipped > 0) {
    console.log(chalk.white(`   No text/empty:   `) + chalk.white(`${formatNumber(otherSkipped)}`) + chalk.dim(` (skipped)`));
  }
  console.log(chalk.white(`   Failed:          `) + (result.failed > 0 ? chalk.red(`${formatNumber(result.failed)}`) : chalk.white(`${formatNumber(result.failed)}`)));
  console.log(chalk.white(`   Time elapsed:    `) + chalk.cyan(`${formatDuration(result.timeMs)}`) + (avgRate ? chalk.dim(` (${avgRate} files/s)`) : ""));
  console.log(chalk.white(`   Index size:      `) + chalk.cyan(`${formatBytes(result.indexSizeBytes)}`));
  console.log();
  console.log(chalk.white(`   Memory: `) + chalk.dim(result.memoryPath));
  console.log();
  console.log(chalk.white(`   Search with: `) + chalk.cyan(`ssm find "your query"`));
  console.log(chalk.white(`   Auto-index:  `) + chalk.cyan(`ssm watch`));
  console.log();
}

/**
 * Index a single image file
 */
async function indexSingleFile(
  imagePath: string,
  options: IndexCommandOptions
): Promise<void> {
  const progress = new ProgressTracker();
  const startTime = Date.now();

  // Header - minimal
  if (!options.quiet) {
    console.log();
    console.log(chalk.white.bold(`Indexing ${basename(imagePath)}`));
    console.log();
  }

  try {
    const workers = options.workers ? parseInt(options.workers, 10) : 1;
    const result = await indexSingleImage(imagePath, {
      workers,
      shutdownOcrAfter: true,
      caption: options.caption ?? true, // Enable by default
      onProgress: (phase, message) => {
        if (!options.quiet) {
          progress.stopCurrent();
          progress.startPhase(phase, message);
        }
      },
    });

    if (result.success) {
      const elapsed = Date.now() - startTime;
      const methodLabel = {
        ocr: "text extracted (OCR)",
        caption: "image described (AI)",
        both: "text + description",
        none: "",
      }[result.method];

      progress.succeed(`Indexed ${basename(imagePath)} — ${methodLabel}`);

      if (!options.quiet) {
        console.log();
        console.log(chalk.green(`Done`) + chalk.dim(` · ${methodLabel} · ${formatDuration(elapsed)}`));
        console.log();
      }
    } else {
      progress.warn(`Skipped`);
      if (!options.quiet) {
        console.log();
        console.log(chalk.yellow(`Skipped`) + chalk.dim(` · no text or description found`));
        if (!options.caption) {
          console.log(chalk.dim(`Try: ssm index --caption ${basename(imagePath)}`));
        }
        console.log();
      }
    }
  } catch (err) {
    progress.fail();
    const { message, suggestion } = formatError(err);
    logger.error(message);
    if (suggestion) {
      logger.log(chalk.gray(`  ${suggestion}`));
    }
    process.exit(1);
  }
}
