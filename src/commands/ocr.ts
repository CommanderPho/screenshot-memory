/**
 * OCR test command - Extract and display text from an image
 */

import chalk from "chalk";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { initializeOcr, processImage, shutdownOcr } from "../ocr/index.js";
import { ProgressTracker } from "../display/progress.js";
import { resolvePath, logger, formatError } from "../utils/index.js";

export interface OcrCommandOptions {
  json?: boolean;
}

/**
 * Execute the OCR test command
 */
export async function ocrCommand(
  imagePath: string,
  options: OcrCommandOptions
): Promise<void> {
  const resolved = resolvePath(imagePath);

  if (!existsSync(resolved)) {
    logger.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const progress = new ProgressTracker();

  try {
    progress.startPhase("ocr", `Running OCR on ${basename(resolved)}...`);

    await initializeOcr({ workers: 1 });
    const result = await processImage(resolved);
    await shutdownOcr();

    progress.succeed(`OCR completed (${result.processingTimeMs}ms)`);

    if (options.json) {
      console.log(JSON.stringify({
        path: resolved,
        text: result.text,
        confidence: result.confidence,
        width: result.metadata.width,
        height: result.metadata.height,
        hasContent: result.hasContent,
        processingTimeMs: result.processingTimeMs,
      }, null, 2));
      return;
    }

    // Clean output
    console.log();
    console.log(chalk.white.bold("Extracted Text"));

    if (result.text.trim()) {
      console.log(chalk.white(result.text));
    } else {
      console.log(chalk.dim("(No text found)"));
    }

    console.log();
    console.log(chalk.dim(
      `${result.confidence.toFixed(0)}% confidence · ` +
      `${result.metadata.width}×${result.metadata.height} · ` +
      `${result.processingTimeMs}ms`
    ));
    console.log();

  } catch (err) {
    progress.fail();
    await shutdownOcr();
    const { message, suggestion } = formatError(err);
    logger.error(message);
    if (suggestion) {
      logger.log(chalk.gray(`  ${suggestion}`));
    }
    process.exit(1);
  }
}
