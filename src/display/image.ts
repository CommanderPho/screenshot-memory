/**
 * Terminal image display module
 * Provides image preview in supported terminals
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { logger } from "../utils/index.js";

export type ImageDisplayMethod =
  | "iterm"
  | "kitty"
  | "chafa"
  | "sixel"
  | "ascii"
  | "none";

let detectedMethod: ImageDisplayMethod | null = null;

/**
 * Detect the best image display method for the current terminal
 */
export function detectDisplayMethod(): ImageDisplayMethod {
  if (detectedMethod !== null) {
    return detectedMethod;
  }

  // Check for CI/non-interactive environments
  if (process.env.CI || !process.stdout.isTTY) {
    detectedMethod = "none";
    return detectedMethod;
  }

  // Prefer chafa - it's the most reliable cross-platform option
  // iTerm2 inline images require user confirmation which can fail
  if (hasCommand("chafa")) {
    detectedMethod = "chafa";
    return detectedMethod;
  }

  // Kitty terminal has native support without confirmation dialogs
  if (process.env.TERM === "xterm-kitty" || process.env.KITTY_WINDOW_ID) {
    detectedMethod = "kitty";
    return detectedMethod;
  }

  // Fallback to none (don't show broken images)
  detectedMethod = "none";
  return detectedMethod;
}

/**
 * Check if a command exists
 */
function hasCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Display an image in the terminal
 */
export async function displayImage(
  imagePath: string,
  options?: {
    width?: number;
    height?: number;
    method?: ImageDisplayMethod;
  }
): Promise<boolean> {
  // Validate image exists
  if (!existsSync(imagePath)) {
    logger.debug(`Image not found: ${imagePath}`);
    return false;
  }

  const width = options?.width || 50;
  const height = options?.height || 15;
  const method = options?.method || detectDisplayMethod();

  if (method === "none") {
    return false;
  }

  try {
    switch (method) {
      case "iterm":
        return displayItermImage(imagePath, width, height);

      case "kitty":
        return displayKittyImage(imagePath, width, height);

      case "chafa":
        return displayChafaImage(imagePath, width, height);

      case "sixel":
        return displaySixelImage(imagePath, width, height);

      case "ascii":
        return displayAsciiPlaceholder(imagePath, width, height);

      default:
        return false;
    }
  } catch (err) {
    logger.debug(`Image display failed: ${err}`);
    return false;
  }
}

/**
 * Display image using iTerm2 inline images
 */
function displayItermImage(
  imagePath: string,
  width: number,
  height: number
): boolean {
  try {
    // iTerm2 inline image protocol
    const { readFileSync } = require("node:fs");
    const imageData = readFileSync(imagePath);
    const base64 = imageData.toString("base64");

    // ESC ] 1337 ; File = [args] : base64 BEL
    const osc = "\x1b]1337;File=";
    const args = `inline=1;width=${width};height=${height};preserveAspectRatio=1`;
    const terminator = "\x07";

    process.stdout.write(`${osc}${args}:${base64}${terminator}\n`);
    return true;
  } catch (err) {
    logger.debug(`iTerm2 display failed: ${err}`);
    return false;
  }
}

/**
 * Display image using Kitty graphics protocol
 */
function displayKittyImage(
  imagePath: string,
  width: number,
  height: number
): boolean {
  try {
    // Use kitty +kitten icat
    const result = execSync(
      `kitty +kitten icat --place ${width}x${height}@0x0 "${imagePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    );
    process.stdout.write(result + "\n");
    return true;
  } catch {
    // Fall back to chafa if kitty icat fails
    if (hasCommand("chafa")) {
      return displayChafaImage(imagePath, width, height);
    }
    return false;
  }
}

/**
 * Display image using chafa (cross-platform)
 */
function displayChafaImage(
  imagePath: string,
  width: number,
  height: number
): boolean {
  try {
    const result = execSync(
      `chafa --size=${width}x${height} --animate=off "${imagePath}"`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );
    process.stdout.write(result);
    return true;
  } catch (err) {
    logger.debug(`chafa display failed: ${err}`);
    return false;
  }
}

/**
 * Display image using sixel graphics
 */
function displaySixelImage(
  imagePath: string,
  width: number,
  height: number
): boolean {
  // Sixel requires special terminal support and image conversion
  // For now, fall back to chafa or ASCII
  if (hasCommand("chafa")) {
    return displayChafaImage(imagePath, width, height);
  }
  return displayAsciiPlaceholder(imagePath, width, height);
}

/**
 * Display ASCII placeholder (fallback)
 */
function displayAsciiPlaceholder(
  _imagePath: string,
  width: number,
  height: number
): boolean {
  // Just show a simple box as placeholder
  const boxWidth = Math.min(width, 40);
  const boxHeight = Math.min(height, 8);

  const top = "┌" + "─".repeat(boxWidth - 2) + "┐";
  const bottom = "└" + "─".repeat(boxWidth - 2) + "┘";
  const middle = "│" + " ".repeat(boxWidth - 2) + "│";
  const center = "│" + " [Image Preview] ".padStart((boxWidth - 2 + 17) / 2).padEnd(boxWidth - 2) + "│";

  console.log(top);
  for (let i = 0; i < Math.floor((boxHeight - 3) / 2); i++) {
    console.log(middle);
  }
  console.log(center);
  for (let i = 0; i < Math.floor((boxHeight - 3) / 2); i++) {
    console.log(middle);
  }
  console.log(bottom);

  return true;
}

/**
 * Check if terminal supports image display
 */
export function supportsImageDisplay(): boolean {
  const method = detectDisplayMethod();
  return method !== "none" && method !== "ascii";
}

/**
 * Get a description of the current display method
 */
export function getDisplayMethodDescription(): string {
  const method = detectDisplayMethod();
  switch (method) {
    case "iterm":
      return "iTerm2 inline images";
    case "kitty":
      return "Kitty graphics protocol";
    case "chafa":
      return "chafa terminal graphics";
    case "sixel":
      return "Sixel graphics";
    case "ascii":
      return "ASCII placeholder";
    case "none":
      return "No image display (non-interactive)";
  }
}
