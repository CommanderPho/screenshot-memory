/**
 * Header-only image checks and ordered path lists.
 * This does not run OCR. It only drops files that cannot be read or are too small.
 */

import { glob } from "glob";
import { readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import pLimit from "p-limit";
import sharp from "sharp";
import { MIN_IMAGE_DIMENSION, SUPPORTED_EXTENSIONS_GLOB, ensureDir, resolvePath } from "../utils/index.js";

export type ImageSort = "newest" | "oldest" | "name" | "size";

export interface ImageRecord {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface AcceptedImage extends ImageRecord {
  width: number;
  height: number;
}

export interface RejectedImage extends ImageRecord {
  reason: "unreadable" | "too-small";
  detail: string;
}

export interface ClassifyOptions {
  minWidth?: number;
  minHeight?: number;
  concurrency?: number;
  onProgress?: (current: number, total: number) => void;
}

export interface ClassifyResult {
  accepted: AcceptedImage[];
  rejected: RejectedImage[];
}

const PREFLIGHT_CONCURRENCY = 32;

/**
 * Find supported images under a directory.
 */
export async function findScreenshotPaths(directory: string): Promise<string[]> {
  const pattern = join(directory, "**", SUPPORTED_EXTENSIONS_GLOB).replace(/\\/g, "/");
  return glob(pattern, {
    nodir: true,
    absolute: true,
  });
}

/**
 * Read a file list written by `ssm scan`. Blank lines and # comments are ignored.
 */
export function readPathList(listPath: string): string[] {
  const text = readFileSync(listPath, "utf8").replace(/^\uFEFF/, "");
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    paths.push(resolvePath(trimmed));
  }
  return paths;
}

/**
 * Write accepted paths, one absolute path per line.
 */
export function writePathList(outPath: string, paths: string[], comment?: string): void {
  ensureDir(dirname(outPath));
  const header = comment ? `${comment.trim()}\n` : "";
  const body = paths.length > 0 ? `${paths.join("\n")}\n` : "";
  writeFileSync(outPath, `${header}${body}`, "utf8");
}

/**
 * Write `path<TAB>reason<TAB>detail` rows for files the header check rejected.
 */
export function writeRejectedReport(outPath: string, rejected: RejectedImage[]): void {
  ensureDir(dirname(outPath));
  const lines = rejected.map((item) =>
    [item.path, item.reason, item.detail.replace(/[\t\r\n]+/g, " ")].join("\t")
  );
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  writeFileSync(outPath, body, "utf8");
}

export function parseImageSort(value: string): ImageSort {
  if (value === "newest" || value === "oldest" || value === "name" || value === "size") {
    return value;
  }
  throw new Error(`Invalid sort "${value}". Expected newest, oldest, name, or size.`);
}

export function compareImageRecords(a: ImageRecord, b: ImageRecord, sort: ImageSort): number {
  switch (sort) {
    case "newest":
      return b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path);
    case "oldest":
      return a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path);
    case "size":
      return b.size - a.size || a.path.localeCompare(b.path);
    case "name":
      return basename(a.path).localeCompare(basename(b.path)) || a.path.localeCompare(b.path);
  }
}

/**
 * Read image headers and split paths into ones OCR can attempt and ones it cannot.
 * Accepted paths keep the input order.
 */
export async function classifyImages(paths: string[], options: ClassifyOptions = {}): Promise<ClassifyResult> {
  const minWidth = options.minWidth ?? MIN_IMAGE_DIMENSION;
  const minHeight = options.minHeight ?? MIN_IMAGE_DIMENSION;
  const limit = pLimit(options.concurrency ?? PREFLIGHT_CONCURRENCY);
  const results: Array<AcceptedImage | RejectedImage> = new Array(paths.length);
  let completed = 0;

  await Promise.all(
    paths.map((imagePath, index) =>
      limit(async () => {
        results[index] = await classifyOne(imagePath, minWidth, minHeight);
        completed++;
        options.onProgress?.(completed, paths.length);
      })
    )
  );

  const accepted: AcceptedImage[] = [];
  const rejected: RejectedImage[] = [];
  for (const item of results) {
    if ("reason" in item) {
      rejected.push(item);
    } else {
      accepted.push(item);
    }
  }

  return { accepted, rejected };
}

async function classifyOne(imagePath: string, minWidth: number, minHeight: number): Promise<AcceptedImage | RejectedImage> {
  const resolved = resolvePath(imagePath);
  let mtimeMs = 0;
  let size = 0;

  try {
    const fileStat = await stat(resolved);
    mtimeMs = fileStat.mtime.getTime();
    size = fileStat.size;
  } catch (err) {
    return {
      path: resolved,
      mtimeMs,
      size,
      reason: "unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (size === 0) {
    return {
      path: resolved,
      mtimeMs,
      size,
      reason: "unreadable",
      detail: "empty file",
    };
  }

  try {
    const metadata = await sharp(resolved, { failOn: "none" }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) {
      return {
        path: resolved,
        mtimeMs,
        size,
        reason: "unreadable",
        detail: "missing dimensions",
      };
    }
    if (width < minWidth || height < minHeight) {
      return {
        path: resolved,
        mtimeMs,
        size,
        reason: "too-small",
        detail: `${width}x${height}`,
      };
    }
    return {
      path: resolved,
      mtimeMs,
      size,
      width,
      height,
    };
  } catch (err) {
    return {
      path: resolved,
      mtimeMs,
      size,
      reason: "unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
