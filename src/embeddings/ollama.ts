/**
 * Local Ollama embedding provider.
 * Vectors are stored in the SQLite index; nothing is uploaded.
 */

export const OLLAMA_EMBED_MODEL = "nomic-embed-text";
export const OLLAMA_EMBED_DIMENSION = 768;

const EMBED_TIMEOUT_MS = 120_000;

export class OllamaEmbeddings {
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

export function getLocalEmbedder(): OllamaEmbeddings {
  if (!instance) {
    instance = new OllamaEmbeddings();
  }
  return instance;
}
