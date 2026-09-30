/**
 * Local Ollama embedding provider.
 * Generates vectors on this machine so memvid does not use its built-in models.
 */

import type { EmbeddingProvider, Memvid, PutManyInput, StatsResult } from "@memvid/sdk";
import { getConfig, logger } from "../utils/index.js";

export const OLLAMA_EMBED_MODEL = "nomic-embed-text";
export const OLLAMA_EMBED_DIMENSION = 768;

/**
 * Memvid's native embedder accepts short aliases only.
 * Config may use those aliases or the full provider model id.
 */
const MEMVID_EMBEDDING_ALIASES: Record<string, string> = {
  "nomic": "nomic",
  "nomic-embed-text": "nomic",
  "nomic-embed-text-v1.5": "nomic",
  "nomic-ai/nomic-embed-text-v1.5": "nomic",
  "bge-small": "bge-small",
  "bge-small-en-v1.5": "bge-small",
  "baai/bge-small-en-v1.5": "bge-small",
  "bge-base": "bge-base",
  "bge-base-en-v1.5": "bge-base",
  "baai/bge-base-en-v1.5": "bge-base",
  "gte-large": "gte-large",
  "thenlper/gte-large": "gte-large",
  "openai-small": "openai-small",
  "text-embedding-3-small": "openai-small",
  "openai-large": "openai-large",
  "openai": "openai-large",
  "text-embedding-3-large": "openai-large",
  "openai-ada": "openai-ada",
  "text-embedding-ada-002": "openai-ada",
};

/** Map a configured model id onto a memvid embedding alias. Unknown names are unchanged. */
export function memvidEmbeddingModel(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/:.*$/, "");
  return MEMVID_EMBEDDING_ALIASES[normalized] ?? normalized;
}

const EMBED_TIMEOUT_MS = 120_000;

export class OllamaEmbeddings implements EmbeddingProvider {
  readonly dimension = OLLAMA_EMBED_DIMENSION;
  readonly provider = "ollama";
  readonly modelName: string;

  private readonly host: string;

  constructor(options?: { host?: string; model?: string }) {
    this.host = (options?.host || process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
    this.modelName = options?.model || OLLAMA_EMBED_MODEL;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.embed(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    if (!vector) {
      throw new Error(`Ollama returned no embedding for the query. Run \`ollama pull ${this.modelName}\`.`);
    }
    return vector;
  }

  private async embed(inputs: string[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.modelName, input: inputs }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(this.unavailableMessage(err));
    }

    if (response.status === 404) {
      const body = await response.text();
      if (this.isMissingModel(body)) {
        throw new Error(this.missingModelMessage());
      }
      return this.embedLegacy(inputs);
    }

    if (!response.ok) {
      const body = await response.text();
      if (this.isMissingModel(body)) {
        throw new Error(this.missingModelMessage());
      }
      throw new Error(`Ollama embeddings failed (${response.status}): ${body || response.statusText}`);
    }

    const data = await response.json() as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) {
      throw new Error(
        `Ollama returned ${Array.isArray(data.embeddings) ? data.embeddings.length : 0} embeddings for ${inputs.length} inputs.`
      );
    }
    return data.embeddings;
  }

  /** Older Ollama servers expose one-text /api/embeddings instead of /api/embed. */
  private async embedLegacy(inputs: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const input of inputs) {
      let response: Response;
      try {
        response = await fetch(`${this.host}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.modelName, prompt: input }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(this.unavailableMessage(err));
      }

      if (!response.ok) {
        const body = await response.text();
        if (this.isMissingModel(body) || response.status === 404) {
          throw new Error(this.missingModelMessage());
        }
        throw new Error(`Ollama embeddings failed (${response.status}): ${body || response.statusText}`);
      }

      const data = await response.json() as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error(`Ollama returned an empty embedding. Run \`ollama pull ${this.modelName}\`.`);
      }
      vectors.push(data.embedding);
    }
    return vectors;
  }

  private isMissingModel(body: string): boolean {
    return /not found/i.test(body) && /model/i.test(body);
  }

  private missingModelMessage(): string {
    return `Ollama embedding model '${this.modelName}' is not installed. Start Ollama with \`ollama serve\`, then run \`ollama pull ${this.modelName}\`.`;
  }

  private unavailableMessage(err: unknown): string {
    const detail = err instanceof Error ? err.message : String(err);
    return `Ollama is not running at ${this.host} (${detail}). Start it with \`ollama serve\`, then run \`ollama pull ${this.modelName}\`.`;
  }
}

let instance: OllamaEmbeddings | null = null;

/** null = not probed yet, false = this process must use Ollama. */
let nativeLocalEmbeddings: boolean | null = null;
let warnedCoreMlFallback = false;

const NATIVE_UNAVAILABLE = "not available on this platform";

const COREML_FAILURE_MARKERS = [
  "CoreMLExecutionProvider",
  "failed to compute embeddings with fastembed",
  "Unable to compute the prediction using a neural network model",
] as const;

export function getLocalEmbedder(): OllamaEmbeddings {
  if (!instance) {
    instance = new OllamaEmbeddings();
  }
  return instance;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** CoreML rejected memvid's built-in fastembed model at runtime. */
export function coreMlEmbeddingFailure(err: unknown): boolean {
  const message = errorMessage(err);
  return COREML_FAILURE_MARKERS.some((marker) => message.includes(marker));
}

export function nativeEmbeddingsUnavailable(err: unknown): boolean {
  return errorMessage(err).includes(NATIVE_UNAVAILABLE) || coreMlEmbeddingFailure(err);
}

function warnCoreMlFallbackOnce(): void {
  if (warnedCoreMlFallback) return;
  warnedCoreMlFallback = true;
  logger.warn(
    `Built-in embeddings failed on CoreML. Using Ollama model '${OLLAMA_EMBED_MODEL}' instead.`
  );
}

function mixedIdentityMessage(): string {
  return (
    "Native embeddings failed, and this index already uses a different embedding model. " +
    `Run \`ssm index --force\` to rebuild it with Ollama (\`ollama serve\`, then \`ollama pull ${OLLAMA_EMBED_MODEL}\`).`
  );
}

/** True when stored vectors came from something other than the Ollama embedder. */
async function hasNonOllamaVectorIdentity(mv: Memvid): Promise<boolean> {
  const stats = await mv.stats();
  const provider = stats.embedding_identity?.provider;
  return typeof provider === "string" && provider.length > 0 && provider !== "ollama";
}

async function putWithOllama(
  mv: Memvid,
  documents: PutManyInput[],
  compressionLevel: number
): Promise<void> {
  await mv.putMany(documents, {
    compressionLevel,
    embedder: getLocalEmbedder(),
  });
}

/**
 * Store documents with memvid's ONNX embedder when this build supports it.
 * If the native library reports that local models are unavailable, or CoreML
 * fails while running them, retry once with Ollama and keep using Ollama for
 * the rest of the process.
 */
export async function putDocuments(mv: Memvid, documents: PutManyInput[]): Promise<void> {
  const config = getConfig();
  const compressionLevel = config.indexing.compressionLevel;

  if (nativeLocalEmbeddings !== false) {
    try {
      await mv.putMany(documents, {
        compressionLevel,
        enableEmbedding: true,
        embeddingModel: memvidEmbeddingModel(config.indexing.embeddingModel),
      });
      nativeLocalEmbeddings = true;
      return;
    } catch (err) {
      if (!nativeEmbeddingsUnavailable(err)) throw err;

      let foreignIdentity = false;
      try {
        foreignIdentity = await hasNonOllamaVectorIdentity(mv);
      } catch (statsErr) {
        logger.debug(`Could not read embedding identity: ${errorMessage(statsErr)}`);
        throw err;
      }
      if (foreignIdentity) {
        throw new Error(mixedIdentityMessage());
      }

      nativeLocalEmbeddings = false;
      if (coreMlEmbeddingFailure(err)) {
        warnCoreMlFallbackOnce();
      } else {
        logger.debug("Native local embeddings are unavailable on this platform; using Ollama");
      }

      try {
        await putWithOllama(mv, documents, compressionLevel);
      } catch (ollamaErr) {
        if (coreMlEmbeddingFailure(err)) {
          throw new Error(`Built-in embeddings failed on CoreML. ${errorMessage(ollamaErr)}`);
        }
        throw ollamaErr;
      }
      return;
    }
  }

  await putWithOllama(mv, documents, compressionLevel);
}

export function memoryUsesOllamaEmbeddings(
  stats: Pick<StatsResult, "embedding_identity">
): boolean {
  return stats.embedding_identity?.provider === "ollama";
}
