import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  classifyImages,
  compareImageRecords,
  readPathList,
  writePathList,
  writeRejectedReport,
} from "./preflight.js";

describe("compareImageRecords", () => {
  const older = { path: "b.png", mtimeMs: 1, size: 10 };
  const newer = { path: "a.png", mtimeMs: 5, size: 3 };

  test("newest puts the recent file first", () => {
    expect(compareImageRecords(older, newer, "newest")).toBeGreaterThan(0);
  });

  test("name uses the file name", () => {
    expect(compareImageRecords(newer, older, "name")).toBeLessThan(0);
  });
});

describe("path lists", () => {
  test("round-trips paths and skips comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ssm-list-"));
    try {
      const listPath = join(dir, "files.txt");
      writePathList(listPath, [join(dir, "one.png"), join(dir, "two.png")], "# comment");
      const read = readPathList(listPath);
      expect(read).toEqual([join(dir, "one.png"), join(dir, "two.png")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyImages", () => {
  test("rejects tiny and unreadable files and keeps a normal image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ssm-preflight-"));
    try {
      const ok = join(dir, "ok.png");
      const tiny = join(dir, "tiny.png");
      const garbage = join(dir, "nope.png");
      await sharp({
        create: { width: 32, height: 24, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toFile(ok);
      await sharp({
        create: { width: 2, height: 36, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .png()
        .toFile(tiny);
      await writeFile(garbage, "not an image");

      const result = await classifyImages([ok, tiny, garbage], { minWidth: 10, minHeight: 10 });
      expect(result.accepted.map((item) => item.path)).toEqual([ok]);
      expect(result.rejected.map((item) => item.reason)).toEqual(["too-small", "unreadable"]);
      expect(result.rejected[0]?.detail).toBe("2x36");

      const report = join(dir, "rejected.txt");
      writeRejectedReport(report, result.rejected);
      const text = await Bun.file(report).text();
      expect(text).toContain("too-small\t2x36");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
