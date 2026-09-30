---
name: CoreML embedding fallback
overview: Indexing fails because memvid’s fastembed model runs on the macOS CoreML provider and that provider errors on this machine. Treat that runtime failure like the existing “native embeddings unavailable” case and store vectors with the local Ollama embedder instead.
todos:
  - id: classify-coreml
    content: Treat CoreML/fastembed runtime errors as native embedding failure and retry the batch with Ollama, without mixing vector identities
    status: completed
  - id: search-message
    content: Give semantic search a rebuild message when an existing fastembed index hits the same CoreML error
    status: completed
  - id: docs-test
    content: Update the README troubleshooting line and add a unit test for the error classifier
    status: completed
isProject: false
---

# Fall back when CoreML embeddings fail

`ssm index` stores text with memvid’s local `bge-small` model (`enableEmbedding: true` in [`src/embeddings/ollama.ts`](src/embeddings/ollama.ts)). On this Mac (`x86_64`, macOS 26.3) `@memvid/sdk` 2.0.151 runs that model through ONNX Runtime’s CoreML execution provider (fastembed 5.8.0). CoreML then returns `Unable to compute the prediction using a neural network model` (error code -1). The native binary has a CPU provider, but no option or env var to select it.

Ollama fallback is already implemented, and search already uses it when the index identity is `provider: "ollama"`. It never runs here because [`nativeEmbeddingsUnavailable`](src/embeddings/ollama.ts) only matches the string `not available on this platform`:

```138:171:src/embeddings/ollama.ts
export function nativeEmbeddingsUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(NATIVE_UNAVAILABLE);
}
// ...
      if (!nativeEmbeddingsUnavailable(err)) throw err;
      nativeLocalEmbeddings = false;
```

## Change

In [`src/embeddings/ollama.ts`](src/embeddings/ollama.ts):

- Treat fastembed/CoreML execution failures as native-embedder failures (`CoreMLExecutionProvider`, `failed to compute embeddings with fastembed`, and the “Unable to compute the prediction using a neural network model” status). Keep the existing platform-unavailable match.
- On that failure, retry the same `putMany` batch with `getLocalEmbedder()` and keep using Ollama for the rest of the process (index, watch, and single-file index all go through `putDocuments`).
- Warn once that the built-in model failed on CoreML and embeddings are coming from `nomic-embed-text`.
- If that retry fails because Ollama is down or the model is missing, keep the current Ollama instructions and prefix them with the CoreML cause so the next step is obvious: `ollama serve` then `ollama pull nomic-embed-text`.
- Only switch when this memory does not already have a non-Ollama vector identity. A later batch must not mix `bge-small` (384d) with `nomic-embed-text` (768d). In that case, fail with a message to rerun `ssm index --force` (force recreates the `.mv2`, the first batch fails CoreML again, and the empty file then uses Ollama).

In [`src/core/searcher.ts`](src/core/searcher.ts), if `find` hits the same CoreML error on an existing fastembed index, say that semantic search needs a rebuild (`ssm index --force`) after the Ollama model is installed. Do not query a `bge-small` index with the 768d Ollama embedder. Indexes written by the fallback already pass `getLocalEmbedder()` via `memoryUsesOllamaEmbeddings`.

Update the semantic-search troubleshooting line in [`README.md`](README.md) so this CoreML error points at the same Ollama fallback.

Add a small bun test for the error classifier so the CoreML message in the report is covered without loading the native model.
