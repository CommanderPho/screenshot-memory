/**
 * Ollama vision provider
 * Uses local Ollama for fast image captioning
 */

import { readFileSync } from "node:fs";
import sharp from "sharp";
import { logger } from "../utils/index.js";
import type { VisionProvider, CaptionResult } from "./types.js";

// Max image size for vision models (resize if larger)
const MAX_IMAGE_SIZE = 1024;

// Default models in order of preference (accuracy + speed balance)
const VISION_MODELS = [
  "llava-phi3",                              // ⭐ Best: accurate + fast (2.9GB)
  "richardyoung/smolvlm2-2.2b-instruct",    // Small + accurate (1.1GB)
  "llava:7b",                                // Very accurate (4GB)
  "minicpm-v",                               // Good accuracy (2.8GB)
  "moondream",                               // Fast but less accurate (1.8GB)
];

const SIMPLE_PROMPT = `What is in this image? Describe it in 1-2 sentences.`;

export class OllamaProvider implements VisionProvider {
  public readonly name = "ollama";

  private host: string;
  private model: string | null = null;
  private available: boolean | null = null;

  constructor(host?: string) {
    this.host = host || process.env.OLLAMA_HOST || "http://localhost:11434";
  }

  /**
   * Check if Ollama is available with a vision model
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      // Check if Ollama is running
      const response = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        this.available = false;
        return false;
      }

      const data = await response.json() as { models?: Array<{ name: string }> };
      const models = data.models?.map((m) => m.name) || [];

      // Find a vision model
      for (const visionModel of VISION_MODELS) {
        const found = models.find((m) =>
          m.toLowerCase().includes(visionModel.toLowerCase().split(":")[0])
        );
        if (found) {
          this.model = found;
          this.available = true;
          logger.debug(`Ollama vision model found: ${this.model}`);
          return true;
        }
      }

      logger.debug(`No vision model found. Available: ${models.join(", ")}`);
      this.available = false;
      return false;
    } catch (err) {
      logger.debug(`Ollama not available: ${err}`);
      this.available = false;
      return false;
    }
  }

  /**
   * Set specific model to use
   */
  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Caption an image
   */
  async caption(imagePath: string): Promise<CaptionResult> {
    if (!this.model) {
      const available = await this.isAvailable();
      if (!available) {
        throw new Error("No Ollama vision model available");
      }
    }

    const startTime = Date.now();

    try {
      // Read, resize, and convert image to JPEG for better compatibility
      const imageBuffer = readFileSync(imagePath);
      const resizedBuffer = await sharp(imageBuffer)
        .resize(MAX_IMAGE_SIZE, MAX_IMAGE_SIZE, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();

      const base64Image = resizedBuffer.toString("base64");
      logger.debug(`Image resized: ${(resizedBuffer.length / 1024).toFixed(0)}KB`);

      // Single API call - simple prompt works best with moondream
      const caption = await this.generate(SIMPLE_PROMPT, base64Image);
      logger.debug(`Raw caption: ${caption}`);

      // Extract tags from caption (nouns, adjectives, colors)
      const tags = this.extractTags(caption);

      return {
        caption,
        tags,
        processingTimeMs: Date.now() - startTime,
        model: this.model!,
        provider: "ollama",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama captioning failed: ${message}`);
    }
  }

  /**
   * Generate response from Ollama
   */
  private async generate(prompt: string, base64Image: string): Promise<string> {
    const response = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        images: [base64Image],
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 256,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as { response?: string };
    return data.response || "";
  }

  async shutdown(): Promise<void> {
    // Nothing to cleanup for Ollama
  }

  /**
   * Extract tags from caption text
   */
  private extractTags(text: string): string[] {
    // Common words to filter out
    const stopWords = new Set([
      "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "shall", "can", "need", "dare",
      "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
      "from", "as", "into", "through", "during", "before", "after", "above",
      "below", "between", "under", "again", "further", "then", "once", "here",
      "there", "when", "where", "why", "how", "all", "each", "few", "more",
      "most", "other", "some", "such", "no", "nor", "not", "only", "own",
      "same", "so", "than", "too", "very", "just", "and", "but", "if", "or",
      "because", "until", "while", "this", "that", "these", "those", "what",
      "which", "who", "whom", "its", "it", "image", "shows", "appears",
      "visible", "seen", "looking", "picture", "photo", "photograph",
    ]);

    // Extract words, filter, and dedupe
    const words = text
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && w.length < 15 && !stopWords.has(w));

    // Dedupe while preserving order
    return [...new Set(words)].slice(0, 15);
  }
}

// Singleton
let instance: OllamaProvider | null = null;

export function getOllamaProvider(host?: string): OllamaProvider {
  if (!instance) {
    instance = new OllamaProvider(host);
  }
  return instance;
}

/**
 * Quick check if Ollama has vision capability
 */
export async function hasOllamaVision(): Promise<boolean> {
  const provider = getOllamaProvider();
  return provider.isAvailable();
}
