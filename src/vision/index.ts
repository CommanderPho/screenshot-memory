/**
 * Vision module for screenshot-memory
 * Provides image captioning for photo search
 */

import { getOllamaProvider, hasOllamaVision } from "./ollama.js";
import { logger } from "../utils/index.js";
import type { CaptionResult, VisionConfig, VisionProvider } from "./types.js";

export type { CaptionResult, VisionConfig, VisionProvider };

// Track current provider
let currentProvider: VisionProvider | null = null;
let initialized = false;

/**
 * Initialize vision module
 */
export async function initializeVision(config?: VisionConfig): Promise<boolean> {
  if (initialized && currentProvider) {
    return true;
  }

  const providerPref = config?.provider || "auto";
  logger.debug(`Initializing vision with provider: ${providerPref}`);

  // Try Ollama first (fastest if available)
  if (providerPref === "auto" || providerPref === "ollama") {
    const ollama = getOllamaProvider(config?.ollamaHost);

    if (config?.ollamaModel) {
      ollama.setModel(config.ollamaModel);
    }

    if (await ollama.isAvailable()) {
      currentProvider = ollama;
      initialized = true;
      logger.debug("Vision initialized with Ollama");
      return true;
    }
  }

  // No provider available
  logger.debug("No vision provider available");
  initialized = true;
  return false;
}

/**
 * Check if vision is available
 */
export async function isVisionAvailable(): Promise<boolean> {
  if (!initialized) {
    return initializeVision();
  }
  return currentProvider !== null;
}

/**
 * Caption an image
 */
export async function captionImage(imagePath: string): Promise<CaptionResult | null> {
  if (!initialized) {
    await initializeVision();
  }

  if (!currentProvider) {
    return null;
  }

  return currentProvider.caption(imagePath);
}

/**
 * Get caption and tags for an image
 * Returns null if no vision provider available
 */
export async function describeImage(imagePath: string): Promise<{
  caption: string;
  tags: string[];
  model: string;
  provider: string;
  processingTimeMs: number;
} | null> {
  const result = await captionImage(imagePath);
  if (!result) return null;

  return {
    caption: result.caption,
    tags: result.tags,
    model: result.model,
    provider: result.provider,
    processingTimeMs: result.processingTimeMs,
  };
}

/**
 * Shutdown vision module
 */
export async function shutdownVision(): Promise<void> {
  if (currentProvider) {
    await currentProvider.shutdown();
    currentProvider = null;
  }
  initialized = false;
}

/**
 * Get current provider name
 */
export function getVisionProviderName(): string | null {
  return currentProvider?.name || null;
}

/**
 * Check what vision capabilities are available
 */
export async function checkVisionCapabilities(): Promise<{
  ollama: boolean;
  ollamaModel?: string;
  recommended: string;
}> {
  const hasOllama = await hasOllamaVision();
  const ollama = getOllamaProvider();

  return {
    ollama: hasOllama,
    ollamaModel: hasOllama ? (ollama as any).model : undefined,
    recommended: hasOllama
      ? "Ready! Ollama vision available."
      : "Install Ollama + moondream for image captioning: ollama pull moondream",
  };
}
