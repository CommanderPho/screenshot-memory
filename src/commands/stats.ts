/**
 * Stats command - Show index statistics
 */

import chalk from "chalk";
import boxen from "boxen";
import { getIndexStats } from "../core/indexer.js";
import { memoryExists } from "../core/memory.js";
import { formatBytes, formatNumber } from "../display/progress.js";
import { getDisplayMethodDescription, supportsImageDisplay } from "../display/image.js";
import { getConfig, getConfigPath, logger, formatError } from "../utils/index.js";
import { APP_VERSION } from "../utils/constants.js";

export interface StatsCommandOptions {
  json?: boolean;
}

/**
 * Execute the stats command
 */
export async function statsCommand(options: StatsCommandOptions): Promise<void> {
  const config = getConfig();

  try {
    // Get index stats
    const stats = await getIndexStats();

    // JSON output
    if (options.json) {
      const output = {
        version: APP_VERSION,
        hasIndex: memoryExists(),
        ...stats,
        config: {
          directories: config.directories,
          ocr: config.ocr,
          search: config.search,
          display: config.display,
        },
        terminal: {
          supportsImages: supportsImageDisplay(),
          displayMethod: getDisplayMethodDescription(),
        },
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Pretty output
    console.log();
    console.log(chalk.bold.cyan("📸 screenshot-memory") + chalk.gray(` v${APP_VERSION}`));
    console.log();

    if (!memoryExists()) {
      console.log(chalk.yellow("No index found."));
      console.log(chalk.gray("Run 'ssm index <directory>' to index your screenshots."));
      console.log();
      return;
    }

    // Index stats box
    const indexContent = [
      `${chalk.white("Screenshots:")}  ${formatNumber(stats.documentCount)}`,
      `${chalk.white("Index size:")}   ${formatBytes(stats.indexSizeBytes)}`,
      `${chalk.white("Lex index:")}    ${stats.hasLexIndex ? chalk.green("✓") : chalk.red("✗")}`,
      `${chalk.white("Vec index:")}    ${stats.hasVecIndex ? chalk.green("✓") : chalk.red("✗")}`,
    ].join("\n");

    const indexBox = boxen(indexContent, {
      padding: 1,
      borderColor: "cyan",
      borderStyle: "round",
      title: "Index",
      titleAlignment: "left",
    });

    console.log(indexBox);

    // Config info
    console.log();
    console.log(chalk.gray("Configuration:"));
    console.log(chalk.gray(`  Memory:     ${stats.memoryPath}`));
    console.log(chalk.gray(`  Config:     ${getConfigPath()}`));
    console.log(chalk.gray(`  OCR:        ${config.ocr.engine} (${config.ocr.workers} workers)`));
    console.log(chalk.gray(`  Search:     ${config.search.defaultMode} mode`));

    // Terminal capabilities
    console.log();
    console.log(chalk.gray("Terminal:"));
    console.log(chalk.gray(`  Images:     ${supportsImageDisplay() ? "supported" : "not supported"}`));
    console.log(chalk.gray(`  Method:     ${getDisplayMethodDescription()}`));

    // Directories
    if (config.directories.length > 0) {
      console.log();
      console.log(chalk.gray("Watched directories:"));
      for (const dir of config.directories) {
        console.log(chalk.gray(`  • ${dir}`));
      }
    }

    console.log();
  } catch (err) {
    const { message, suggestion } = formatError(err);
    logger.error(message);
    if (suggestion) {
      logger.log(chalk.gray(`  ${suggestion}`));
    }
    process.exit(1);
  }
}
