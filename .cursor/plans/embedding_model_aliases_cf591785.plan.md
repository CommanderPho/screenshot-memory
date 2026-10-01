---
name: Embedding model aliases
overview: "`indexing.embeddingModel` is stored correctly as `nomic-embed-text`. Memvid’s native embedder rejects that full name and only accepts short aliases (`nomic`, `bge-small`, and so on). Translate known full names to those aliases before indexing."
todos:
  - id: normalize-model
    content: Add memvidEmbeddingModel() and use it in putDocuments
    status: completed
  - id: tests
    content: Cover nomic-embed-text, tags, short aliases, and unknown names
    status: completed
isProject: false
---

# Accept full embedding model names

The failure is not a dash-stripping parser. [`config.json`](/Users/pho/Library/Preferences/screenshot-memory-nodejs/config.json) already contains the full string `nomic-embed-text`, and [`putDocuments`](src/embeddings/ollama.ts) passes that string through:

```204:208:src/embeddings/ollama.ts
      await mv.putMany(documents, {
        compressionLevel,
        enableEmbedding: true,
        embeddingModel: config.indexing.embeddingModel,
      });
```

Memvid’s native allowlist (from the error and `@memvid/sdk` `LOCAL_EMBEDDING_MODELS`) is `bge-small`, `bge-base`, `nomic`, `gte-large`, `openai-large`, `openai-small`, `openai-ada`. Several of those already contain dashes. `nomic` is the alias for Nomic Embed Text v1.5; `nomic-embed-text` is the Ollama name and is not on that list, so `putMany` fails before the Ollama fallback (that fallback only runs for CoreML / “local models unavailable”).

Leave the preference file as `nomic-embed-text`. Normalize it in this app.

## Change

Add `memvidEmbeddingModel(name: string)` in [`src/embeddings/ollama.ts`](src/embeddings/ollama.ts) and use it for the `embeddingModel` option above.

- Trim, lowercase, and drop an Ollama tag suffix (`nomic-embed-text:latest` → `nomic-embed-text`).
- Map known full ids onto memvid aliases, and pass already-valid aliases through unchanged:
  - `nomic`, `nomic-embed-text`, `nomic-embed-text-v1.5`, `nomic-ai/nomic-embed-text-v1.5` → `nomic`
  - `bge-small`, `bge-small-en-v1.5`, `baai/bge-small-en-v1.5` → `bge-small`
  - `bge-base`, `bge-base-en-v1.5`, `baai/bge-base-en-v1.5` → `bge-base`
  - `gte-large`, `thenlper/gte-large` → `gte-large`
  - `openai-small`, `text-embedding-3-small` → `openai-small`
  - `openai-large`, `openai`, `text-embedding-3-large` → `openai-large`
  - `openai-ada`, `text-embedding-ada-002` → `openai-ada`
- Unknown names stay unchanged so memvid still reports them.

This selects memvid’s built-in Nomic model (768-d), which is what `indexing.embeddingModel` already controls. The Ollama fallback stays on the hardcoded `nomic-embed-text` model.

## Tests

Extend [`src/embeddings/ollama.test.ts`](src/embeddings/ollama.test.ts) to cover `nomic-embed-text`, `nomic-embed-text:latest`, the short alias `nomic`, `bge-small`, and an unknown name left unchanged.
