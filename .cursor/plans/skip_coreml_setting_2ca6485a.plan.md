---
name: Skip CoreML setting
overview: Add an indexing.skipCoreML config flag that never calls memvid's ONNX embedder, stores vectors with Ollama instead, and turns that flag on in this machine's config.
todos:
  - id: config-flag
    content: Add indexing.skipCoreML to defaults, types, and Conf schema, and set it true in this machine's config.json
    status: pending
  - id: index-path
    content: When skipCoreML is set, store with Ollama only and refuse to mix into an existing native index
    status: pending
  - id: search-docs
    content: Keep semantic search off CoreML when the flag is set, and document the flag
    status: pending
isProject: false
---

# Skip CoreML from config

`"embeddingModel": "nomic"` is still passed to memvid's native ONNX embedder in [`putNativeBatch`](src/embeddings/ollama.ts), so CoreML stays in the path. Ollama is only used after that native call fails, and only when the `.mv2` file has no other embedding identity.

## Setting

Add `indexing.skipCoreML` (boolean, default `false`) to [`src/utils/constants.ts`](src/utils/constants.ts), the `IndexingConfig` type, and the Conf schema in [`src/utils/config.ts`](src/utils/config.ts).

Set it to `true` in [`/Users/pho/Library/Preferences/screenshot-memory-nodejs/config.json`](/Users/pho/Library/Preferences/screenshot-memory-nodejs/config.json):

```json
"indexing": {
  "batchSize": 100,
  "compressionLevel": 3,
  "embeddingModel": "nomic",
  "skipCoreML": true
}
```

`embeddingModel` is not sent to memvid while the flag is on. Vectors come from Ollama's `nomic-embed-text` (`ollama serve` and `ollama pull nomic-embed-text`).

## Behavior

In [`putDocuments`](src/embeddings/ollama.ts), when `skipCoreML` is true, skip `putNativeBatch` and call `putWithOllama` directly.

If `mv.stats()` already reports a non-Ollama embedding identity, do not write Ollama vectors into that file. Throw the existing rebuild message (`ssm index --force`). `--force` recreates `screenshots.mv2`, so the next write is Ollama-only. The current example index was built with the native model, so the first Desktop index after this change needs that rebuild.

In [`src/core/searcher.ts`](src/core/searcher.ts), semantic and auto search already pass `getLocalEmbedder()` when the index identity is `ollama`. If `skipCoreML` is set and the identity is still the native model, do not call `find` with the native embedder (that is another CoreML run). Throw a `SearchError` telling the user to rebuild with `ssm index --force`. Lexical search is unchanged.

Mention the flag in the config example and the CoreML troubleshooting line in [`README.md`](README.md).
