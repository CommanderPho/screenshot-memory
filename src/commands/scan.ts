/**
 * Scan command - header-only pass that writes an ordered file list
 */

import chalk from "chalk";
import { existsSync, statSync } from "node:fs";
import {
  classifyImages,
  compareImageRecords,
  findScreenshotPaths,
  parseImageSort,
  writePathList,
  writeRejectedReport,
  type ImageSort,
} from "../core/preflight.js";
import { ProgressTracker, formatDuration, formatNumber } from "../display/progress.js";
import {
  getConfig,
  getDefaultScreenshotDirs,
  logger,
  resolvePath,
} from "../utils/index.js";

export interface ScanCommandOptions {
  out?: string;
  rejected?: string;
  sort?: string;
  minWidth?: string;
  minHeight?: string;
}

/**
 * Check images quickly and write the ones worth OCR, in a chosen order.
 */
export async function scanCommand(
  pathArg: string | undefined,
  options: ScanCommandOptions
): Promise<void> {
  if (!options.out) {
    logger.error("Missing --out <file> for the accepted path list.");
    logger.log(chalk.gray("  Usage: ssm scan <directory> --out files.txt"));
    process.exit(1);
  }

  let sort: ImageSort;
  try {
    sort = parseImageSort(options.sort || "newest");
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const minWidth = parseDimension(options.minWidth, "min-width");
  const minHeight = parseDimension(options.minHeight, "min-height");
  const directory = resolveDirectory(pathArg);
  const outPath = resolvePath(options.out);
  const rejectedPath = options.rejected ? resolvePath(options.rejected) : undefined;

  console.log();
  console.log(chalk.bold.cyan("📸 screenshot-memory"));
  console.log(chalk.white(`   Directory: `) + chalk.cyan(directory));
  console.log(chalk.white(`   Order:     `) + chalk.cyan(sort));
  console.log();

  const progress = new ProgressTracker();
  const started = Date.now();

  try {
    progress.startPhase("scanning", "Scanning for screenshots...");
    const imagePaths = await findScreenshotPaths(directory);
    progress.succeed();

    if (imagePaths.length === 0) {
      logger.error(`No screenshots found in: ${directory}`);
      process.exit(1);
    }

    progress.startProgressPhase(
      "preflight",
      imagePaths.length,
      `Checking ${formatNumber(imagePaths.length)} images...`
    );

    const classified = await classifyImages(imagePaths, {
      minWidth,
      minHeight,
      onProgress: (current) => {
        progress.update(current);
      },
    });
    progress.succeed();

    const accepted = [...classified.accepted].sort((a, b) => compareImageRecords(a, b, sort));
    const comment = `# screenshot-memory scan\n# sort: ${sort}`;
    writePathList(outPath, accepted.map((item) => item.path), comment);
    if (rejectedPath) {
      writeRejectedReport(rejectedPath, classified.rejected);
    }

    const elapsed = Date.now() - started;
    console.log();
    console.log(chalk.green.bold("Scan complete"));
    console.log();
    console.log(chalk.white(`   Accepted: `) + chalk.cyan(formatNumber(accepted.length)));
    console.log(chalk.white(`   Rejected: `) + (classified.rejected.length > 0 ? chalk.yellow(formatNumber(classified.rejected.length)) : chalk.white("0")));
    console.log(chalk.white(`   Time:     `) + chalk.cyan(formatDuration(elapsed)));
    console.log(chalk.white(`   File list: `) + chalk.dim(outPath));
    if (rejectedPath) {
      console.log(chalk.white(`   Rejected report: `) + chalk.dim(rejectedPath));
    }
    console.log();
    console.log(chalk.white(`   Index with: `) + chalk.cyan(`ssm index --files "${outPath}"`));
    console.log();
  } catch (err) {
    progress.fail();
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function resolveDirectory(pathArg: string | undefined): string {
  const config = getConfig();
  let directory: string;

  if (pathArg) {
    directory = resolvePath(pathArg);
  } else if (config.directories.length > 0) {
    directory = config.directories[0];
  } else {
    const detected = getDefaultScreenshotDirs();
    if (detected.length === 0) {
      logger.error("No screenshot directory specified or detected.");
      logger.log(chalk.gray("  Usage: ssm scan <directory> --out files.txt"));
      process.exit(1);
    }
    directory = detected[0];
  }

  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    logger.error(`Directory not found: ${directory}`);
    process.exit(1);
  }

  return directory;
}

function parseDimension(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.error(`Invalid --${flag}: ${value}`);
    process.exit(1);
  }
  return parsed;
}
