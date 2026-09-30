/**
 * Browse command - Display paginated table of indexed screenshots
 */

import { basename } from "node:path";
import chalk from "chalk";
import { open } from "@memvid/sdk";
import type { TimelineEntry } from "@memvid/sdk";
import { loadCatalog, type CatalogEntry } from "../core/catalog.js";
import { memoryExists } from "../core/memory.js";
import { formatBytes, formatNumber } from "../display/progress.js";
import { getConfig, resolvePath, logger } from "../utils/index.js";

export interface BrowseCommandOptions {
  limit?: number;
  page?: number;
  status?: string;
  sort?: string;
  desc?: boolean;
  json?: boolean;
  csv?: boolean;
  fullText?: boolean;
  color?: boolean;
}

export interface BrowseRow {
  filename: string;
  path: string;
  status: string;
  indexedAt: number;
  modifiedAt: number;
  sizeBytes: number;
  preview: string;
}

/**
 * Execute the browse command
 */
export async function browseCommand(
  directoryFilter: string | undefined,
  options: BrowseCommandOptions
): Promise<void> {
  const config = getConfig();

  // Defaults
  const limit = options.limit ?? 20;
  const page = options.page ?? 1;
  const sortKey = options.sort ?? "date";
  const sortDesc = options.desc !== false; // default true for date
  const statusFilter = options.status ?? "all";

  try {
    // Load catalog
    const catalog = await loadCatalog(config.memoryPath);
    let entries: CatalogEntry[] = catalog.allEntries();

    // Filter by directory
    if (directoryFilter) {
      const normalized = resolvePath(directoryFilter);
      const sep = normalized.endsWith("/") || normalized.endsWith("\\") ? "" : "/";
      entries = entries.filter(
        (e) =>
          e.path.startsWith(normalized + sep) ||
          e.path.startsWith(normalized + "\\") ||
          e.path === normalized
      );
    }

    // Filter by status
    if (statusFilter !== "all") {
      entries = entries.filter((e) => e.status === statusFilter);
    }

    // Sort
    entries = sortEntries(entries, sortKey, sortDesc);

    const totalCount = entries.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const offset = (currentPage - 1) * limit;
    const pageSlice = entries.slice(offset, offset + limit);

    // Build preview map (fast path: timeline)
    const previewMap = new Map<string, string>();
    if (memoryExists()) {
      try {
        const mv = await open(config.memoryPath);
        const timeline: TimelineEntry[] = await mv.timeline();
        for (const te of timeline) {
          if (te.uri) {
            previewMap.set(te.uri, te.preview ?? "");
          }
        }

        // Slow path: full text per entry
        if (options.fullText) {
          // Build a map of uri -> frame_id from timeline
          const frameIdMap = new Map<string, number>();
          for (const te of timeline) {
            if (te.uri) {
              frameIdMap.set(te.uri, te.frame_id);
            }
          }

          for (const entry of pageSlice) {
            if (entry.status === "indexed") {
              const frameId = frameIdMap.get(entry.path);
              if (frameId !== undefined) {
                try {
                  const fullText = await mv.view(frameId);
                  previewMap.set(entry.path, fullText);
                } catch {
                  // non-fatal: keep existing preview
                }
              }
            }
          }
        }
      } catch (err) {
        logger.debug(`Could not load memory for previews: ${err}`);
        // non-fatal: continue without previews
      }
    }

    // Build BrowseRow array
    const rows: BrowseRow[] = pageSlice.map((entry) => ({
      filename: basename(entry.path),
      path: entry.path,
      status: entry.status,
      indexedAt: entry.indexedAt,
      modifiedAt: entry.mtimeMs,
      sizeBytes: entry.size,
      preview: previewMap.get(entry.path) ?? "",
    }));

    // Output
    if (options.json) {
      outputJson({ page: currentPage, totalPages, totalCount, rows });
    } else if (options.csv) {
      outputCsv(rows);
    } else {
      outputTable(rows, { page: currentPage, totalPages, totalCount, options });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Browse failed: ${message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortEntries(
  entries: CatalogEntry[],
  sortKey: string,
  desc: boolean
): CatalogEntry[] {
  const sorted = [...entries].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "path":
      case "name":
        cmp = a.path.localeCompare(b.path);
        break;
      case "size":
        cmp = a.size - b.size;
        break;
      case "status":
        cmp = a.status.localeCompare(b.status);
        break;
      case "date":
      default:
        cmp = a.indexedAt - b.indexedAt;
        break;
    }
    return desc ? -cmp : cmp;
  });
  return sorted;
}

// ---------------------------------------------------------------------------
// Output: Table
// ---------------------------------------------------------------------------

interface TableContext {
  page: number;
  totalPages: number;
  totalCount: number;
  options: BrowseCommandOptions;
}

function outputTable(rows: BrowseRow[], ctx: TableContext): void {
  const useColor = ctx.options.color !== false;
  const termWidth = process.stdout.columns || 120;

  // Column widths (fixed except preview which gets the rest)
  const COL_NUM = 4;    // "#   "
  const COL_STATUS = 8; // "indexed "
  const COL_DATE = 12;  // "2024-01-01  "
  const COL_SIZE = 9;   // "1023.4 KB "
  const GAPS = 5;       // separators between columns
  // Filename: up to 30 chars or 25% of terminal
  const COL_FILENAME = Math.min(30, Math.floor(termWidth * 0.25));
  const previewWidth = Math.max(
    10,
    termWidth - COL_NUM - COL_STATUS - COL_DATE - COL_SIZE - COL_FILENAME - GAPS
  );

  const hr = chalk.gray("─".repeat(termWidth));

  // Header
  console.log();
  const header =
    pad("#", COL_NUM) +
    pad("Filename", COL_FILENAME) +
    pad("Status", COL_STATUS) +
    pad("Date", COL_DATE) +
    pad("Size", COL_SIZE) +
    "Preview";
  console.log(useColor ? chalk.bold.white(header) : header);
  console.log(hr);

  // Rows
  if (rows.length === 0) {
    console.log(chalk.gray("  (no results)"));
  } else {
    rows.forEach((row, i) => {
      const num = String((ctx.page - 1) * (ctx.options.limit ?? 20) + i + 1);
      const filename = truncate(row.filename, COL_FILENAME - 1);
      const date = formatDate(row.indexedAt);
      const size = formatBytes(row.sizeBytes);
      const previewText = truncate(row.preview.replace(/\n/g, " "), previewWidth);

      let statusStr: string;
      if (useColor) {
        statusStr = colorStatus(row.status, COL_STATUS - 1);
      } else {
        statusStr = pad(row.status, COL_STATUS);
      }

      const line =
        pad(num, COL_NUM) +
        pad(filename, COL_FILENAME) +
        (useColor ? statusStr + " " : statusStr) +
        pad(date, COL_DATE) +
        pad(size, COL_SIZE) +
        previewText;

      console.log(line);
    });
  }

  console.log(hr);

  // Footer
  const { page, totalPages, totalCount } = ctx;
  const nextPage = page < totalPages ? page + 1 : null;
  const nextHint = nextPage ? chalk.gray(`  ssm browse --page ${nextPage}`) : "";
  const footerLeft = `Page ${page} of ${totalPages}  ·  ${formatNumber(totalCount)} total`;
  console.log(useColor ? chalk.gray(footerLeft) + nextHint : footerLeft);
  console.log();
}

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function colorStatus(status: string, padWidth: number): string {
  const padded = pad(status, padWidth);
  switch (status) {
    case "indexed":
      return chalk.green(padded);
    case "empty":
      return chalk.gray(padded);
    case "failed":
      return chalk.red(padded);
    default:
      return padded;
  }
}

function formatDate(timestampMs: number): string {
  if (!timestampMs) return "—";
  const d = new Date(timestampMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Output: JSON
// ---------------------------------------------------------------------------

function outputJson(payload: {
  page: number;
  totalPages: number;
  totalCount: number;
  rows: BrowseRow[];
}): void {
  console.log(JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// Output: CSV
// ---------------------------------------------------------------------------

function outputCsv(rows: BrowseRow[]): void {
  const header = ["filename", "path", "status", "indexedAt", "modifiedAt", "sizeBytes", "preview"];
  console.log(header.join(","));

  for (const row of rows) {
    const fields = [
      csvEscape(row.filename),
      csvEscape(row.path),
      csvEscape(row.status),
      String(row.indexedAt),
      String(row.modifiedAt),
      String(row.sizeBytes),
      csvEscape(row.preview),
    ];
    console.log(fields.join(","));
  }
}

function csvEscape(value: string): string {
  // Wrap in quotes if value contains comma, double-quote, or newline
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
