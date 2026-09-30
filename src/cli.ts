#!/usr/bin/env bun

/**
 * screenshot-memory CLI
 * Find any screenshot by what's IN it.
 */

// Suppress noisy system/native messages globally (must be before any imports)
const _origErr = console.error;
const _origWarn = console.warn;
const _origStderr = process.stderr.write.bind(process.stderr);
const _origStdout = process.stdout.write.bind(process.stdout);
const _isNoise = (s: string) =>
  s.includes("Context leak") ||
  s.includes("msgtracer") ||
  s.includes("Warning: Invalid resolution") ||
  s.includes("Warning: Invalid dpi") ||
  s.includes("Image too small to scale") ||
  s.includes("Line cannot be recognized") ||
  s.includes("cannot be recognized") ||
  s.includes("min width of");

console.error = (...a: unknown[]) => { if (!_isNoise(String(a[0] || ""))) _origErr.apply(console, a); };
console.warn = (...a: unknown[]) => { if (!_isNoise(String(a[0] || ""))) _origWarn.apply(console, a); };
process.stderr.write = ((c: any, ...a: any[]) => _isNoise(String(c)) ? true : _origStderr(c, ...a)) as any;
process.stdout.write = ((c: any, ...a: any[]) => _isNoise(String(c)) ? true : _origStdout(c, ...a)) as any;

import { Command } from "commander";
import chalk from "chalk";
import { indexCommand, findCommand, watchCommand, statsCommand, interactiveSearch, ocrCommand, captionCommand } from "./commands/index.js";
import { memoryExists } from "./core/memory.js";
import { APP_VERSION, APP_NAME } from "./utils/constants.js";
import { setLogLevel } from "./utils/logger.js";

// Create program
const program = new Command();

// Program metadata
program
  .name(APP_NAME)
  .description("Find any screenshot by what's IN it.")
  .version(APP_VERSION, "-v, --version", "Show version number");

// Global options
program
  .option("-q, --quiet", "Suppress non-essential output")
  .option("--debug", "Enable debug output");

// Parse global options
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.quiet) {
    setLogLevel("error");
  }
  if (opts.debug) {
    setLogLevel("debug");
  }
});

// Index command
program
  .command("index [directory]")
  .description("Index screenshots from a directory or single image")
  .option("-w, --workers <number>", "Number of OCR workers (default: 4)")
  .option("-f, --force", "Force re-index all screenshots")
  .option("-c, --caption", "Enable AI image captioning (requires Ollama)")
  .option("--no-caption", "Disable AI image captioning")
  .option("-q, --quiet", "Suppress progress output")
  .action(indexCommand);

// Find command
program
  .command("find <query>")
  .alias("f")
  .alias("search")
  .description("Search for screenshots by content")
  .option("-k, --limit <number>", "Number of results to show (default: 5)")
  .option("-m, --mode <mode>", "Search mode: lex, sem, auto (default: auto)")
  .option("-o, --open", "Open the first result")
  .option("--json", "Output results as JSON")
  .option("--no-preview", "Disable image preview")
  .action(findCommand);

// Watch command
program
  .command("watch [directory]")
  .description("Watch for new screenshots and auto-index")
  .option("-d, --daemon", "Run in background (daemon mode)")
  .action(watchCommand);

// Stats command
program
  .command("stats")
  .alias("status")
  .alias("info")
  .description("Show index statistics and configuration")
  .option("--json", "Output as JSON")
  .action(statsCommand);

// OCR test command
program
  .command("ocr <image>")
  .description("Test OCR text extraction on an image")
  .option("--json", "Output as JSON")
  .action(ocrCommand);

// Caption test command
program
  .command("caption <image>")
  .description("Test AI image captioning (requires Ollama)")
  .option("--json", "Output as JSON")
  .action(captionCommand);

// Interactive mode (default when no command)
program
  .command("interactive", { isDefault: false })
  .alias("i")
  .description("Start interactive search mode")
  .action(async () => {
    await interactiveSearch();
  });

// Default action (when no command is provided)
program.action(async () => {
  // If no index exists, show help
  if (!memoryExists()) {
    console.log();
    console.log(chalk.bold.cyan("📸 screenshot-memory") + chalk.gray(` v${APP_VERSION}`));
    console.log();
    console.log(chalk.white("Find any screenshot by what's IN it."));
    console.log();
    console.log(chalk.gray("Get started:"));
    console.log(chalk.gray("  1. Index your screenshots:  ") + chalk.cyan("ssm index ~/Screenshots"));
    console.log(chalk.gray("  2. Search for content:      ") + chalk.cyan('ssm find "error message"'));
    console.log(chalk.gray("  3. Auto-index new ones:     ") + chalk.cyan("ssm watch"));
    console.log();
    console.log(chalk.gray("Run ") + chalk.cyan("ssm --help") + chalk.gray(" for all commands."));
    console.log();
    return;
  }

  // If index exists, start interactive mode
  await interactiveSearch();
});

// Error handling
program.exitOverride((err) => {
  if (err.code === "commander.help" || err.code === "commander.version") {
    process.exit(0);
  }
  process.exit(1);
});

// Parse arguments
try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof Error) {
    console.error(chalk.red(`Error: ${err.message}`));
  }
  process.exit(1);
}
