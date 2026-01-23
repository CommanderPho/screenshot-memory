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
    console.log(chalk.white(`   Indexing: `) + chalk.cyan(directory));
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
            case "ocr":
              progress.startProgressPhase(
                "ocr",
                p.total,
                `Processing ${formatNumber(p.total)} screenshots...`
              );
              break;
            case "indexing":
              progress.startProgressPhase(
                "indexing",
                p.total,
                `Storing ${formatNumber(p.total)} documents...`
              );
              break;
            case "finalizing":
              progress.startPhase("finalizing", "Optimizing index...");
              break;
          }
          lastPhase = p.phase;
        }

        // Update progress
        if (p.phase === "ocr" || p.phase === "indexing") {
          progress.update(p.current, {
            filename: p.currentFile ? basename(p.currentFile) : "",
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
  console.log();
  console.log(chalk.green.bold("✅ Indexing complete!"));
  console.log();
  console.log(chalk.white.bold("   Summary"));
  console.log(chalk.white(`   Indexed:     `) + chalk.cyan(`${formatNumber(result.indexed)} screenshots`));
  console.log(chalk.white(`   Skipped:     `) + chalk.white(`${formatNumber(result.skipped)}`) + chalk.dim(` (no text or already indexed)`));
  console.log(chalk.white(`   Failed:      `) + chalk.white(`${formatNumber(result.failed)}`));
  console.log(chalk.white(`   Time:        `) + chalk.cyan(`${formatDuration(result.timeMs)}`));
  console.log(chalk.white(`   Index size:  `) + chalk.cyan(`${formatBytes(result.indexSizeBytes)}`));
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
