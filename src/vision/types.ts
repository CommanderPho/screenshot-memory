/**
 * Vision module types
 */

export interface CaptionResult {
  /** Generated caption/description */
  caption: string;
  /** Detected objects/tags */
  tags: string[];
  /** Processing time in ms */
  processingTimeMs: number;
  /** Model used */
  model: string;
  /** Provider used */
  provider: "ollama" | "transformers" | "none";
}

export interface VisionProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  caption(imagePath: string): Promise<CaptionResult>;
  shutdown(): Promise<void>;
}

export interface VisionConfig {
  /** Preferred provider */
  provider?: "ollama" | "transformers" | "auto";
  /** Ollama model to use */
  ollamaModel?: string;
  /** Ollama host */
  ollamaHost?: string;
  /** Custom prompt for captioning */
  prompt?: string;
}
