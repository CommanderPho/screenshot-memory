import { describe, expect, test } from "bun:test";
import { coreMlEmbeddingFailure, memvidEmbeddingModel, nativeEmbeddingsUnavailable } from "./ollama.js";

const COREML_ERROR =
  "Embedding failed: failed to compute embeddings with fastembed: Non-zero status code returned while running CoreMLExecutionProvider node. " +
  "Status Message: Error executing model: Unable to compute the prediction using a neural network model. " +
  "It can be an invalid input data or broken/unsupported model (error code: -1).";

describe("nativeEmbeddingsUnavailable", () => {
  test("matches the platform-unavailable message", () => {
    expect(
      nativeEmbeddingsUnavailable(new Error("local embedding models are not available on this platform"))
    ).toBe(true);
  });

  test("matches the CoreML fastembed failure from macOS", () => {
    expect(nativeEmbeddingsUnavailable(new Error(COREML_ERROR))).toBe(true);
    expect(coreMlEmbeddingFailure(new Error(COREML_ERROR))).toBe(true);
  });

  test("matches each CoreML marker on its own", () => {
    expect(coreMlEmbeddingFailure(new Error("CoreMLExecutionProvider failed"))).toBe(true);
    expect(coreMlEmbeddingFailure(new Error("failed to compute embeddings with fastembed"))).toBe(true);
    expect(
      coreMlEmbeddingFailure(new Error("Unable to compute the prediction using a neural network model"))
    ).toBe(true);
  });

  test("ignores unrelated storage errors", () => {
    const err = new Error("disk full");
    expect(nativeEmbeddingsUnavailable(err)).toBe(false);
    expect(coreMlEmbeddingFailure(err)).toBe(false);
  });

  test("accepts a string error", () => {
    expect(nativeEmbeddingsUnavailable("not available on this platform")).toBe(true);
  });
});

describe("memvidEmbeddingModel", () => {
  test("maps the Ollama nomic id to the memvid alias", () => {
    expect(memvidEmbeddingModel("nomic-embed-text")).toBe("nomic");
    expect(memvidEmbeddingModel("  Nomic-Embed-Text  ")).toBe("nomic");
  });

  test("drops an Ollama tag suffix before mapping", () => {
    expect(memvidEmbeddingModel("nomic-embed-text:latest")).toBe("nomic");
  });

  test("passes short aliases through", () => {
    expect(memvidEmbeddingModel("nomic")).toBe("nomic");
    expect(memvidEmbeddingModel("bge-small")).toBe("bge-small");
  });

  test("leaves unknown names unchanged", () => {
    expect(memvidEmbeddingModel("custom-embedder")).toBe("custom-embedder");
  });
});
