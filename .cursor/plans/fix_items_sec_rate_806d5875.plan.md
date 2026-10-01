---
name: Fix items/sec rate
overview: The indexing progress rate is a lifetime average of every file marked done, including files that only reuse already-stored OCR text. Those early hits will be left in the progress fraction and kept out of items/sec and ETA.
todos:
  - id: throughput-count
    content: Track throughput in the indexer, excluding rememberMovedFile reuse, and pass it on progress updates
    status: completed
  - id: rate-formatter
    content: Compute items/sec and ETA from throughput when present; show -- until measured work exists
    status: completed
  - id: rate-test
    content: Unit-test the rate helper for excluded reuse, normal work, and zero throughput
    status: completed
isProject: false
---

# Keep already-done files out of items/sec

The line `3.9% | 396/10,078 | ⏱ 19.1s | ETA: 7m 46s | 21/s` is drawn in [`src/display/progress.ts`](src/display/progress.ts). Items/sec is `params.value / elapsed`, and ETA is the remaining count divided by that rate.

`params.value` is `processed` from [`src/core/indexer.ts`](src/core/indexer.ts). Two kinds of “already done” files exist:

- Catalog up to date **and** `embedded_at` set: removed before the bar starts (`alreadyIndexedCount`). They are not in `396/10,078`.
- No catalog row, but OCR text already in SQLite: [`rememberMovedFile`](src/core/ocr-backup.ts) reuses that text, then `processed++` and `onProgress` run immediately, before the embedding batch finishes. On a resumed `--files` list those hits come first, so the lifetime average starts far above later OCR speed and only drifts down as slower files are mixed in.

```44:49:src/display/progress.ts
        const rate = params.value > 0 && elapsedMs > 0 ? params.value / (elapsedMs / 1000) : 0;
        const remaining = Math.max(0, params.total - params.value);
        const etaMs = rate > 0 ? (remaining / rate) * 1000 : 0;
```

The fraction and percentage stay on `processed` / `total`, so the bar still moves when stored text is reused. Only the rate and ETA change.

## Rate basis

Add a `throughput` count on `IndexProgress`, passed through the progress payload in [`src/commands/index-cmd.ts`](src/commands/index-cmd.ts).

Increment `throughput` for work that actually ran in the worker: invalid image, OCR, empty-after-OCR, and failures. Do not increment it on the `rememberMovedFile` return. Upfront catalog skips stay out of both `processed` and `throughput`.

In the progress formatter, when `payload.throughput` is a number:

- rate = `throughput / elapsed` (same bar clock)
- if `throughput` is 0, show `--/s` and `ETA: --` instead of a zero-time ETA
- otherwise ETA = `(total - value) / rate`, so the remaining files are estimated at the measured speed, not the reuse burst

Preflight and scan keep today’s behavior by not setting `throughput`, so the formatter falls back to `params.value`.

While a run is still only reusing stored text, the counter stays `--/s` until the first OCR (or other measured) completion. That is the point: those reuse hits no longer set the expected speed.

## Test

Extract the rate/ETA decision into a small pure helper next to the formatter and cover it with a bun test:

- 396 done, 19.1s, throughput 396 → about 21/s (nothing excluded)
- 396 done, throughput much smaller → rate follows throughput only
- throughput 0 with work remaining → `--/s` and `--` ETA
