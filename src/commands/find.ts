/**
 * Find command - Search for screenshots
 */

import chalk from "chalk";
import { search, type SearchMode } from "../core/searcher.js";
import { memoryExists } from "../core/memory.js";
import { displayResults } from "../display/results.js";
import { getConfig, logger, formatError } from "../utils/index.js";

export interface FindCommandOptions {
  limit?: string;
  mode?: string;
  open?: boolean;
  json?: boolean;
  noPreview?: boolean;
}

/**
 * Execute the find command
 */
export async function findCommand(
  query: string,
  options: FindCommandOptions
): Promise<void> {
  const config = getConfig();

  // Validate query
  if (!query || query.trim().length === 0) {
    logger.error("Search query is required.");
    logger.log(chalk.gray("  Usage: ssm find <query>"));
    logger.log(chalk.gray('  Example: ssm find "error message"'));
    process.exit(1);
  }

  // Check if index exists
  if (!memoryExists()) {
    logger.error("No screenshots indexed yet.");
    logger.log(chalk.gray("  Run 'ssm index <directory>' first."));
    logger.log(chalk.gray("  Example: ssm index ~/Screenshots"));
    process.exit(1);
  }

  // Parse options
  const limit = options.limit ? parseInt(options.limit, 10) : config.search.defaultLimit;
  const mode = (options.mode as SearchMode) || config.search.defaultMode;

  // Validate mode
  if (!["lex", "sem", "auto"].includes(mode)) {
    logger.error(`Invalid search mode: ${mode}`);
    logger.log(chalk.gray("  Valid modes: lex (lexical), sem (semantic), auto (hybrid)"));
    process.exit(1);
  }

  try {
    // Execute search
    const result = await search(query.trim(), {
      mode,
      limit,
      minRelevancy: config.search.minRelevancy,
      snippetChars: config.search.snippetChars,
      adaptive: true,
    });

    // Display results
    await displayResults(result, {
      showPreview: !options.noPreview && config.display.imagePreview,
      openFirst: options.open,
      json: options.json,
    });

    // Exit with appropriate code
    if (result.hits.length === 0) {
      process.exit(1);
    }
  } catch (err) {
    const { message, suggestion } = formatError(err);
    logger.error(message);
    if (suggestion) {
      logger.log(chalk.gray(`  ${suggestion}`));
    }
    process.exit(1);
  }
}

/**
 * Interactive search (for future use)
 */
export async function interactiveSearch(): Promise<void> {
  // @ts-expect-error - inquirer types
  const inquirer = (await import("inquirer")).default;
  const config = getConfig();

  // Check if index exists
  if (!memoryExists()) {
    logger.error("No screenshots indexed yet.");
    logger.log(chalk.gray("  Run 'ssm index <directory>' first."));
    return;
  }

  console.log();
  console.log(chalk.bold.cyan("📸 screenshot-memory"));
  console.log(chalk.gray("   Type your search query and press Enter."));
  console.log(chalk.gray("   Type 'quit' or press Ctrl+C to exit."));
  console.log();

  while (true) {
    const { query } = await inquirer.prompt([
      {
        type: "input",
        name: "query",
        message: "Search:",
        prefix: chalk.cyan("?"),
      },
    ]);

    // Exit conditions
    if (!query || query.toLowerCase() === "quit" || query.toLowerCase() === "exit") {
      console.log(chalk.gray("Goodbye!"));
      break;
    }

    try {
      const result = await search(query.trim(), {
        limit: config.search.defaultLimit,
        adaptive: true,
      });

      await displayResults(result, {
        showPreview: config.display.imagePreview,
        compact: true,
      });
    } catch (err) {
      const { message } = formatError(err);
      logger.error(message);
    }

    console.log();
  }
}
