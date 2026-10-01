import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OcrBackup, hashImageFile, ocrBackupPath } from "./ocr-backup.js";

async function tempBackup(): Promise<{ dir: string; backup: OcrBackup }> {
  const dir = await mkdtemp(join(tmpdir(), "ssm-ocr-"));
  const backup = await OcrBackup.open(join(dir, "screenshots.mv2"));
  return { dir, backup };
}

describe("ocr backup", () => {
  test("database sits next to the memvid file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ssm-ocr-path-"));
    try {
      expect(ocrBackupPath(join(dir, "screenshots.mv2"))).toBe(
        join(dir, "screenshots.ocr.sqlite")
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("looks up text by path and does not hash on a hit", async () => {
    const { dir, backup } = await tempBackup();
    try {
      const imagePath = join(dir, "shot.png");
      await writeFile(imagePath, "same-bytes");
      backup.upsert({
        path: imagePath,
        contentHash: hashImageFile(imagePath),
        text: "   ",
        mtimeMs: 1,
        size: 10,
      });
      expect(backup.findByPath(imagePath)).toBeNull();

      backup.upsert({
        path: imagePath,
        contentHash: hashImageFile(imagePath),
        text: "stripe declined",
        title: "shot.png",
        mtimeMs: 1,
        size: 10,
        confidence: 90,
        method: "ocr",
      });

      const found = backup.findByPathOrHash(imagePath, () => {
        throw new Error("path hit must not hash the file");
      });
      expect(found?.matchedBy).toBe("path");
      expect(found?.text).toBe("stripe declined");
      expect(found?.contentHash).toBe(hashImageFile(imagePath));
    } finally {
      backup.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hash fallback recognizes a renamed file and keeps the old path", async () => {
    const { dir, backup } = await tempBackup();
    try {
      const original = join(dir, "a.png");
      const renamed = join(dir, "b.png");
      const different = join(dir, "c.png");
      await writeFile(original, "pixel-bytes");
      await writeFile(renamed, "pixel-bytes");
      await writeFile(different, "other-bytes");

      backup.upsert({
        path: original,
        contentHash: hashImageFile(original),
        text: "invoice total",
        title: "a.png",
        mtimeMs: 1,
        size: 11,
        method: "ocr",
      });

      const found = backup.findByPathOrHash(renamed, () => readFileSync(renamed));
      expect(found?.matchedBy).toBe("hash");
      expect(found?.text).toBe("invoice total");
      expect(found?.path).toBe(original);

      const remembered = backup.rememberMovedFile(renamed, { mtimeMs: 2, size: 11 });
      expect(remembered?.text).toBe("invoice total");
      expect(backup.findByPath(original)?.text).toBe("invoice total");
      expect(backup.findByPath(renamed)?.text).toBe("invoice total");
      expect(backup.findByPath(renamed)?.contentHash).toBe(hashImageFile(original));

      const miss = backup.findByPathOrHash(different, () => readFileSync(different));
      expect(miss).toBeNull();
    } finally {
      backup.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
