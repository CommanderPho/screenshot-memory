---
name: Retry smaller embed batches
overview: CoreML can embed the existing small example index, then fails on a 50-document batch and the Ollama fallback correctly refuses to mix models. Retry that native batch in smaller pieces so Desktop screenshots stay on the same embedder.
todos:
  - id: split-native-batch
    content: On CoreML failure of a multi-document putMany, retry smaller native batches before any Ollama switch or mixed-identity error
    status: pending
  - id: skip-single-doc
    content: If one document still fails CoreML on an existing non-Ollama index, warn and skip it without failing the rest of the batch
    status: pending
  - id: split-test
    content: Add a bun test for when a CoreML error should split versus fall back
    status: pending
isProject: false
---

# Retry native embeddings in smaller batches

`ssm index examples` already stored 6 screenshots with memvid's built-in model (112 KB at `screenshots.mv2`). `ssm index ~/Desktop/Screenshots` then sends up to 50 documents at once (`BATCH_INSERT_SIZE` in [`src/utils/constants.ts`](src/utils/constants.ts)). CoreML rejects that larger `putMany`, and [`putDocuments`](src/embeddings/ollama.ts) sees a non-Ollama embedding identity and stops:

```221:223:src/embeddings/ollama.ts
      if (foreignIdentity) {
        throw new Error(mixedIdentityMessage());
      }
```

Switching that batch to `nomic-embed-text` would mix 768-d vectors into a 384-d index. `--force` would also wipe the working example index. Smaller native batches match the case that already succeeded.

## Change

In [`src/embeddings/ollama.ts`](src/embeddings/ollama.ts), when native `putMany` fails with a CoreML/fastembed error and the batch has more than one document, split it in half and retry each half with the same built-in model. Repeat until a single document succeeds or fails. Do this before the Ollama switch and before the mixed-identity error.

- A single document that still fails, and a memory that already has a non-Ollama identity: warn and skip that document. Do not change embedder and do not fail the rest of the batch (documents already written in earlier splits stay).
- A single document that fails on an empty memory: keep the current Ollama fallback, including the one-time CoreML warning and the prefixed Ollama error if `nomic-embed-text` is missing.
- Leave the platform-unavailable path as it is (immediate Ollama fallback, no split).

Add a bun test for the split decision: a CoreML error with more than one document retries smaller native batches; a single document does not; an unrelated error does not.
