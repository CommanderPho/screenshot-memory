# `ssm browse` — Browse Indexed Screenshots Table

## Goal

Add a `ssm browse` command that outputs a paginated, filterable table of all indexed
screenshots alongside their OCR'd text and metadata. Supports multiple output modes
(terminal table, JSON, CSV) so results can be piped into other tools.

---

## Data Sources

Two complementary sources are available:

| Source | What it provides | Limitation |
|---|---|---|
| **Catalog** (`*.mv2.manifest.json`) | Path, mtime, size, indexedAt, status (`indexed`/`empty`/`failed`) | No OCR text |
| **Memvid `timeline()`** | frame_id, uri, timestamp, preview (truncated text) | Only `indexed` docs; preview is truncated |
| **Memvid `view(frameId)`** | Full OCR text for a single frame | One round-trip per frame |

**Strategy:** Use the catalog as the primary source for the full file list.
- By default show **only `indexed` entries** (those with real OCR text).
- Use `--status empty|failed|all` to widen the filter.
- Enrich with text previews via bulk `timeline()` (fast — one call to get all frame previews).
- Use `--full-text` to retrieve complete OCR text via `view(frameId)` per row (slow).

---

## Design Decisions (confirmed with user)

- ✅ Default filter: **indexed only**
- ✅ Default output: **plain terminal table** (pipe-friendly)
- ✅ Default columns: include **preview snippet** via bulk `timeline()`


---

## Proposed Changes

### New CLI command

#### [MODIFY] `src/cli.ts`

Add a `browse` command registration:

```diff
+import { browseCommand } from "./commands/index.js";

 // Stats command
 program
   .command("stats")
   ...

+// Browse command
+program
+  .command("browse [directory]")
+  .description("Browse indexed screenshots and their OCR'd text")
+  .option("-n, --limit <number>", "Rows per page (default: 50)")
+  .option("-p, --page <number>", "Page number (default: 1)")
+  .option("-s, --status <status>", "Filter by status: indexed|empty|failed|all (default: all)")
+  .option("--sort <field>", "Sort by: path|date|size|status (default: date)")
+  .option("--desc", "Sort descending")
+  .option("--json", "Output as JSON array")
+  .option("--csv", "Output as CSV")
+  .option("--full-text", "Include full OCR text (slow — one read per row)")
+  .option("--no-color", "Disable color output")
+  .action(browseCommand);
```

---

### New browse command

#### [NEW] `src/commands/browse.ts`

This is the main new file. It:
1. Loads the catalog (always fast — just reads the JSON manifest)
2. Optionally filters by directory substring, status
3. Sorts the entries
4. Slices for pagination
5. For `indexed` entries, enriches with a preview from `timeline()` (fast — bulk call)
6. With `--full-text`, calls `view(frameId)` for each row (slow)
7. Outputs a formatted table, JSON, or CSV

```typescript
/**
 * Browse command — output paginated table of indexed screenshots + OCR text
 */
import chalk from "chalk";
import { loadCatalog } from "../core/catalog.js";
import { getMemory, memoryExists } from "../core/memory.js";
import { getConfig, resolvePath, logger, formatError } from "../utils/index.js";
import { formatBytes, formatNumber } from "../display/progress.js";
import type { CatalogEntry } from "../core/catalog.js";

export interface BrowseCommandOptions {
  limit?: string;
  page?: string;
  status?: string;
  sort?: string;
  desc?: boolean;
  json?: boolean;
  csv?: boolean;
  fullText?: boolean;
  color?: boolean;  // commander --no-color sets this to false
}

export interface BrowseRow {
  filename: string;
  path: string;
  status: string;
  indexedAt: string;    // ISO date
  modifiedAt: string;   // ISO date
  sizeBytes: number;
  preview: string;      // Truncated OCR text or empty
}

export async function browseCommand(
  directoryFilter: string | undefined,
  options: BrowseCommandOptions
): Promise<void> {
  const config = getConfig();
  const limit = Math.max(1, parseInt(options.limit || "50", 10));
  const page  = Math.max(1, parseInt(options.page  || "1",  10));
  const statusFilter = options.status || "all";
  const sortField = options.sort || "date";
  const sortDesc  = options.desc ?? true;  // newest-first by default

  // Load catalog
  const catalog = await loadCatalog(config.memoryPath);
  let entries: CatalogEntry[] = [...catalog.entries()];  // expose via new getter

  // Filter by directory
  if (directoryFilter) {
    const resolved = resolvePath(directoryFilter);
    entries = entries.filter(e => e.path.startsWith(resolved));
  }

  // Filter by status
  if (statusFilter !== "all") {
    entries = entries.filter(e => e.status === statusFilter);
  }

  // Sort
  entries.sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case "path":   cmp = a.path.localeCompare(b.path); break;
      case "size":   cmp = a.size - b.size; break;
      case "status": cmp = a.status.localeCompare(b.status); break;
      default:       cmp = a.indexedAt - b.indexedAt; break; // "date"
    }
    return sortDesc ? -cmp : cmp;
  });

  const totalCount = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const pageSlice  = entries.slice((page - 1) * limit, page * limit);

  // Build preview map from memvid timeline (only for indexed entries)
  const previewMap = new Map<string, string>();

  if (memoryExists()) {
    try {
      const mv = await getMemory();
      if (!options.fullText) {
        // Fast path: use timeline() to get previews in bulk
        const timelineEntries = await mv.timeline({ limit: 100_000 });
        for (const te of timelineEntries) {
          if (te.uri) previewMap.set(te.uri, te.preview || "");
        }
      } else {
        // Slow path: view() each indexed frame for full text
        const timelineEntries = await mv.timeline({ limit: 100_000 });
        const frameMap = new Map<string, number>();
        for (const te of timelineEntries) {
          if (te.uri) frameMap.set(te.uri, te.frame_id);
        }
        const indexedSlice = pageSlice.filter(e => e.status === "indexed");
        await Promise.all(indexedSlice.map(async (e) => {
          const frameId = frameMap.get(e.path);
          if (frameId !== undefined) {
            try {
              const text = await mv.view(frameId);
              previewMap.set(e.path, text);
            } catch { /* ignore */ }
          }
        }));
      }
    } catch (err) {
      logger.debug(`Could not load memory for previews: ${err}`);
    }
  }

  // Build rows
  const rows: BrowseRow[] = pageSlice.map(e => ({
    filename:   basename(e.path),
    path:       e.path,
    status:     e.status,
    indexedAt:  new Date(e.indexedAt).toISOString(),
    modifiedAt: new Date(e.mtimeMs).toISOString(),
    sizeBytes:  e.size,
    preview:    previewMap.get(e.path) || "",
  }));

  // Output
  if (options.json) { outputJson(rows, totalCount, page, totalPages); return; }
  if (options.csv)  { outputCsv(rows); return; }
  outputTable(rows, totalCount, page, totalPages, limit, options);
}
```

**Table rendering** uses aligned columns with chalk coloring:

```
 #    Filename                           Status    Date        Size     Preview
 1    2024-01-15_error_dialog.png        indexed   2024-01-15  142 KB   An error occurred: Cannot read properties of...
 2    screenshot_2024-01-14_toolbar.png  indexed   2024-01-14   98 KB   File  Edit  View  Window  Help | New Tab | ...
 3    tiny_icon.png                      empty     2024-01-13    2 KB   (no text)
 4    corrupted.png                      failed    2024-01-12   55 KB   (failed)
...
Page 1 of 274  ·  13,645 total  ·  ssm browse --page 2
```

---

### Catalog getter

#### [MODIFY] `src/core/catalog.ts`

Expose an `entries()` iterator so the browse command can read all entries without
accessing private fields:

```diff
+  /** Iterate all entries in the catalog */
+  entries(): IterableIterator<CatalogEntry> {
+    return this.entries.values();
+  }
```

> [!WARNING]
> Minor naming conflict: the private field and the method both want to be named `entries`.
> Solution: rename the private field to `_entries` (or use `allEntries()` for the public getter).

---

### Barrel exports

#### [MODIFY] `src/commands/index.ts`

```diff
+export { browseCommand, type BrowseCommandOptions } from "./browse.js";
```

---

## Verification Plan

### Automated Tests

No test suite currently exists. After implementation, verify the build:

```powershell
npm run build
```

### Manual Verification

```powershell
# Show first page of all indexed images (default)
ssm browse

# Filter by directory
ssm browse "E:\Dropbox\Screenshots\ShareX Screenshots"

# Show only images with no text (empty status)
ssm browse --status empty

# JSON output for scripting
ssm browse --json | ConvertFrom-Json | Select-Object -First 5

# CSV for spreadsheet
ssm browse --csv > screenshots.csv

# Full OCR text (slow)
ssm browse --full-text --limit 10

# Navigate pages
ssm browse --page 2 --limit 100
```

The table should render cleanly without interfering with the terminal, and JSON/CSV
outputs should be parseable.
