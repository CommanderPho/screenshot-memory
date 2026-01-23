/**
 * Caption command - Test image captioning
 */

import chalk from "chalk";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { glob } from "glob";
import { initializeVision, describeImage, checkVisionCapabilities, shutdownVision } from "../vision/index.js";
import { ProgressTracker } from "../display/progress.js";
import { resolvePath, logger, formatError } from "../utils/index.js";

export interface CaptionCommandOptions {
  json?: boolean;
}

/**
 * Execute the caption test command
 */
export async function captionCommand(
  imagePath: string,
  options: CaptionCommandOptions
): Promise<void> {
  const resolved = resolvePath(imagePath);

  if (!existsSync(resolved)) {
    logger.error(`Path not found: ${resolved}`);
    process.exit(1);
  }

  // Handle directory - process all images
  const stats = statSync(resolved);
  if (stats.isDirectory()) {
    await captionDirectory(resolved, options);
    return;
  }

  const progress = new ProgressTracker();

  try {
    // Check vision capabilities
    progress.startPhase("check", "Checking vision capabilities...");
    const capabilities = await checkVisionCapabilities();

    if (!capabilities.ollama) {
      progress.warn("No vision provider available");
      console.log();
      console.log(chalk.yellow("⚠️  No vision model available"));
      console.log();
      console.log(chalk.white("To enable image captioning, install Ollama with a vision model:"));
      console.log();
      console.log(chalk.cyan("  1. Install Ollama: https://ollama.ai"));
      console.log(chalk.cyan("  2. Pull a vision model:"));
      console.log(chalk.gray("     ollama pull moondream    # Fast, small (~1.8GB)"));
      console.log(chalk.gray("     ollama pull llava:7b     # Better quality (~4GB)"));
      console.log();
      process.exit(1);
    }

    // Initialize vision
    await initializeVision();

    // Caption image
    progress.setText(`Analyzing ${basename(resolved)}...`);
    const result = await describeImage(resolved);
    await shutdownVision();

    if (!result) {
      progress.fail("Captioning failed");
      process.exit(1);
    }

    progress.succeed(`Analyzed in ${result.processingTimeMs}ms`);

    if (options.json) {
      console.log(JSON.stringify({
        path: resolved,
        caption: result.caption,
        tags: result.tags,
        model: result.model,
        provider: result.provider,
        processingTimeMs: result.processingTimeMs,
      }, null, 2));
      return;
    }

    // Clean, readable output
    console.log();
    console.log(chalk.white.bold("Description"));
    console.log(chalk.white(result.caption));
    console.log();

    if (result.tags.length > 0) {
      console.log(chalk.white.bold("Tags"));
      console.log(chalk.cyan(result.tags.join(" · ")));
      console.log();
    }

    console.log(chalk.dim(`${result.model} · ${result.processingTimeMs}ms`));
    console.log();

  } catch (err) {
    progress.fail();
    await shutdownVision();
    const { message, suggestion } = formatError(err);
    logger.error(message);
    if (suggestion) {
      logger.log(chalk.gray(`  ${suggestion}`));
    }
    process.exit(1);
  }
}

/**
 * Caption all images in a directory
 */
async function captionDirectory(
  directory: string,
  options: CaptionCommandOptions
): Promise<void> {
  // Find all images
  const pattern = join(directory, "**/*.{png,jpg,jpeg,webp,gif,bmp}");
  const images = await glob(pattern, { nodir: true, absolute: true });

  if (images.length === 0) {
    console.log(chalk.yellow(`No images found in ${directory}`));
    return;
  }

  console.log();
  console.log(chalk.white.bold(`Found ${images.length} images`));
  console.log();

  // Check vision capabilities
  const capabilities = await checkVisionCapabilities();
  if (!capabilities.ollama) {
    console.log(chalk.yellow("No vision model available"));
    console.log(chalk.dim("Install: ollama pull llava-phi3"));
    return;
  }

  await initializeVision();

  const results: Array<{ file: string; caption: string; tags: string[]; time: number }> = [];

  for (const imagePath of images) {
    const filename = basename(imagePath);
    process.stdout.write(chalk.dim(`${filename}... `));

    try {
      const result = await describeImage(imagePath);
      if (result) {
        results.push({
          file: filename,
          caption: result.caption,
          tags: result.tags,
          time: result.processingTimeMs,
        });
        console.log(chalk.green(`${result.processingTimeMs}ms`));
      } else {
        console.log(chalk.yellow("skipped"));
      }
    } catch (err) {
      console.log(chalk.red("failed"));
    }
  }

  await shutdownVision();

  // Output results
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log();
  console.log(chalk.white.bold("Results"));
  console.log();

  for (const r of results) {
    console.log(chalk.white.bold(r.file));
    console.log(chalk.white(r.caption));
    console.log(chalk.cyan(r.tags.slice(0, 8).join(" · ")));
    console.log();
  }

  const totalTime = results.reduce((sum, r) => sum + r.time, 0);
  console.log(chalk.dim(`${results.length} images · ${totalTime}ms total · ${Math.round(totalTime / results.length)}ms avg`));
}
