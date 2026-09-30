# Implementation Plan: `ssm browse` — Browse Indexed Screenshots Table

## Overview

Add a `ssm browse` command that outputs a paginated, filterable table of all indexed
screenshots alongside their OCR text previews and metadata. Supports terminal table,
JSON, and CSV output modes.

## Tasks

- [x] 1. Verify catalog API and SDK timeline/view signatures
  - Confirm `allEntries()` already exists on `IndexCatalog` in `src/core/catalog.ts` (returns `CatalogEntry[]`)
  - Read `@memvid/sdk` type declarations to confirm `timeline()` and `view()` method signatures and what `te.uri` contains vs catalog path keys (normalized absolute paths)
  - If `allEntries()` is missing, add it to `IndexCatalog`; if private field is named `entries` causing a conflict, rename to `_entries` first
  - If SDK `uri` field does not match catalog path keys, document the mapping needed in `browse.ts`
  - _Requirements: none_

- [x] 2. Implement `src/commands/browse.ts`
  - Define `BrowseCommandOptions` interface (limit, page, status, sort, desc, json, csv, fullText, color) and `BrowseRow` interface (filename, path, status, indexedAt, modifiedAt, sizeBytes, preview)
  - Implement `browseCommand(directoryFilter, options)`: load catalog via `loadCatalog(config.memoryPath)`, call `catalog.allEntries()`, filter by directory (normalize with `resolvePath`) and by status (default: `"all"`), sort by `path|size|status|date` with date-descending as default, paginate with limit/page
  - Implement fast preview path (default): if `memoryExists()`, open memory and call bulk `timeline()` to build `Map<uri, preview>`; wrap in try/catch — failure is non-fatal
  - Implement slow preview path (`--full-text`): additionally call `view(frameId)` per indexed row in the page slice; wrap in try/catch
  - Build `BrowseRow[]` from page slice; import `basename` from `node:path`; use `formatBytes`/`formatNumber` from `../display/progress.js`
  - Implement `outputTable()`: columns `#  Filename  Status  Date  Size  Preview`; color-code status (indexed=green, empty=gray, failed=red, skip when `options.color===false`); truncate columns to `process.stdout.columns`; footer `Page X of Y  ·  N total  ·  ssm browse --page <next>`
  - Implement `outputJson()`: print `JSON.stringify({ page, totalPages, totalCount, rows }, null, 2)`
  - Implement `outputCsv()`: header row + one CSV line per row; escape `"` and commas in preview text
  - _Requirements: 1_

- [x] 3. Export browse command from commands barrel
  - Add to `src/commands/index.ts`: `export { browseCommand, type BrowseCommandOptions } from "./browse.js";`
  - _Requirements: 2_

- [x] 4. Register `browse` command in `src/cli.ts`
  - Add `browseCommand` to the named import from `"./commands/index.js"`
  - Register the command after the stats block: `program.command("browse [directory]")` with options `--limit`, `--page`, `--status`, `--sort`, `--desc`, `--json`, `--csv`, `--full-text`, `--no-color` and `.action(browseCommand)`
  - _Requirements: 2, 3_

- [x] 5. Build and smoke test
  - Run `npm run build` from the project root — must complete with zero TypeScript errors
  - Fix any type errors (likely: SDK signature mismatches, missing `basename` import, wrong `CatalogEntry` field names)
  - Smoke test: `bun run src/cli.ts browse --help` — verify `browse` command appears with all expected options listed
  - _Requirements: 2, 3, 4_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"] },
    { "wave": 2, "tasks": ["2"] },
    { "wave": 3, "tasks": ["3"] },
    { "wave": 4, "tasks": ["4"] },
    { "wave": 5, "tasks": ["5"] }
  ]
}
```

Tasks are strictly sequential: each depends on the previous. Task 2 requires the SDK signature findings from Task 1 to implement correctly.

## Notes

- `catalog.allEntries()` already exists in the codebase — no catalog changes needed unless the SDK URI mapping requires a helper
- `chalk`, `boxen`, `cli-progress` are already in `package.json` — no new dependencies needed
- The `--no-color` commander flag sets `options.color` to `false` automatically (commander convention)
- Default status filter in the plan is `"indexed"` in the data source section but `"all"` in the CLI option default — the CLI registration uses `"all"` as the default, matching the `.option()` definition
