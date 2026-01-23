/**
 * Search results display module
 * Formats and displays search results beautifully
 */

import chalk from "chalk";
import boxen from "boxen";
import figures from "figures";
import { formatDistanceToNow } from "date-fns";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { displayImage, supportsImageDisplay } from "./image.js";
import { getConfig, logger } from "../utils/index.js";
import type { SearchResult, SearchHit } from "../core/searcher.js";

export interface DisplayOptions {
  /** Show image preview */
  showPreview?: boolean;
  /** Open first result */
  openFirst?: boolean;
  /** Show as JSON */
  json?: boolean;
  /** Compact mode (no preview, less detail) */
  compact?: boolean;
}

/**
 * Display search results
 */
export async function displayResults(
  result: SearchResult,
  options?: DisplayOptions
): Promise<void> {
  const config = getConfig();
  const showPreview = options?.showPreview ?? config.display.imagePreview;

  // JSON output
  if (options?.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // No results
  if (result.hits.length === 0) {
    console.log();
    console.log(
      chalk.yellow(`${figures.warning} No screenshots found for "${result.query}"`)
    );
    console.log(chalk.gray("  Try a different search term or check if screenshots are indexed."));
    console.log();
    return;
  }

  // Header - clean and minimal
  console.log();
  console.log(
    chalk.white.bold(`Found ${result.totalHits} result${result.totalHits !== 1 ? "s" : ""}`) +
    chalk.dim(` · ${result.tookMs}ms`)
  );
  console.log();

  // Display each hit
  for (let i = 0; i < result.hits.length; i++) {
    const hit = result.hits[i];
    await displayHit(hit, i + 1, {
      showPreview: showPreview && !options?.compact,
      previewWidth: config.display.previewWidth,
      previewHeight: config.display.previewHeight,
    });
  }

  // Open first result if requested
  if (options?.openFirst && result.hits.length > 0) {
    await openImage(result.hits[0].metadata.path);
  }
}

/**
 * Display a single search hit
 */
async function displayHit(
  hit: SearchHit,
  index: number,
  options: {
    showPreview: boolean;
    previewWidth: number;
    previewHeight: number;
  }
): Promise<void> {
  const { path, timestamp, width, height } = hit.metadata;

  // Image preview
  if (options.showPreview && existsSync(path) && supportsImageDisplay()) {
    await displayImage(path, {
      width: options.previewWidth,
      height: options.previewHeight,
    });
  }

  // Clean, compact result display
  // Show match count instead of raw score (more meaningful for users)
  const matchCount = hit.matches || 0;

  // Title line with match count
  console.log(
    chalk.white.bold(`${index}.`) +
    chalk.white(` ${hit.title}`) +
    (matchCount > 0 ? chalk.dim(` · `) + chalk.cyan(`${matchCount} matches`) : "")
  );

  // Snippet
  const snippet = formatSnippet(hit.snippet, 100);
  console.log(chalk.white(`   ${snippet}`));

  // Metadata line
  const timeAgo = timestamp
    ? formatDistanceToNow(new Date(timestamp), { addSuffix: true })
    : "";
  const dimensions = width && height ? `${width}×${height}` : "";

  const metaParts = [timeAgo, dimensions].filter(Boolean);
  console.log(chalk.dim(`   ${metaParts.join(" · ")}`));

  // Path
  console.log(chalk.dim(`   ${path}`));
  console.log();
}

/**
 * Format snippet for display
 */
function formatSnippet(text: string, maxLength: number): string {
  // Clean up whitespace
  const cleaned = text.replace(/\s+/g, " ").trim();

  // Truncate if needed
  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return cleaned.slice(0, maxLength - 3) + "...";
}

/**
 * Open an image with the default viewer
 */
export async function openImage(imagePath: string): Promise<void> {
  if (!existsSync(imagePath)) {
    logger.warn(`Cannot open: file not found: ${imagePath}`);
    return;
  }

  const command = process.platform === "darwin"
    ? `open "${imagePath}"`
    : process.platform === "win32"
      ? `start "" "${imagePath}"`
      : `xdg-open "${imagePath}"`;

  return new Promise((resolve) => {
    exec(command, (error) => {
      if (error) {
        logger.debug(`Failed to open image: ${error}`);
      }
      resolve();
    });
  });
}

/**
 * Display results in compact mode (for interactive use)
 */
export function displayCompactResults(result: SearchResult): void {
  if (result.hits.length === 0) {
    console.log(chalk.yellow("No results"));
    return;
  }

  console.log(
    chalk.gray(`${result.totalHits} results (${result.tookMs}ms)`)
  );
  console.log();

  for (let i = 0; i < result.hits.length; i++) {
    const hit = result.hits[i];
    const timeAgo = hit.metadata.timestamp
      ? formatDistanceToNow(new Date(hit.metadata.timestamp), { addSuffix: true })
      : "";

    console.log(
      chalk.white(`${i + 1}. `) +
      chalk.cyan(hit.title) +
      chalk.gray(` - ${timeAgo}`)
    );
    console.log(
      chalk.gray(`   ${formatSnippet(hit.snippet, 60)}`)
    );
  }
}

/**
 * Display a single result card (boxed)
 */
export function displayResultCard(hit: SearchHit, index?: number): void {
  const timeAgo = hit.metadata.timestamp
    ? formatDistanceToNow(new Date(hit.metadata.timestamp), { addSuffix: true })
    : "";

  const content = [
    chalk.bold.cyan(`📸 ${hit.title}`),
    "",
    chalk.white(`"${formatSnippet(hit.snippet, 60)}"`),
    "",
    chalk.gray(`${timeAgo} · ${hit.metadata.path}`),
  ].join("\n");

  const box = boxen(content, {
    padding: 1,
    margin: { top: 0, bottom: 1, left: 0, right: 0 },
    borderColor: "cyan",
    borderStyle: "round",
    title: index !== undefined ? `Result ${index}` : undefined,
    titleAlignment: "left",
  });

  console.log(box);
}
