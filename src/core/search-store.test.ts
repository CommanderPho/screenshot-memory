import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reciprocalRankFusion } from "./search-store.js";
import { SearchStore } from "./search-store.js";

describe("reciprocal rank fusion", () => {
  test("ranks a document that appears in both lists ahead of one-list hits", () => {
    const fused = reciprocalRankFusion([
      ["alpha", "both"],
      ["both", "gamma"],
    ]);
    expect(fused.map((item) => item.id)).toEqual(["both", "alpha", "gamma"]);
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  test("keeps a single list in its original order", () => {
    const fused = reciprocalRankFusion([["first", "second", "third"]]);
    expect(fused.map((item) => item.id)).toEqual(["first", "second", "third"]);
  });
});

describe("sqlite search index", () => {
  test("matches keywords, returns the nearer vector, and keeps the row after reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ssm-search-"));
    const memoryPath = join(dir, "screenshots.mv2");
    const invoice = join(dir, "invoice.png");
    const beach = join(dir, "beach.png");
    const store = await SearchStore.open(memoryPath);
    try {
      store.texts.upsert({
        path: invoice,
        contentHash: "invoice",
        text: "invoice stripe declined for the card",
        title: "invoice.png",
        mtimeMs: 1,
        size: 10,
      });
      store.texts.upsert({
        path: beach,
        contentHash: "beach",
        text: "vacation beach photo with no receipt",
        title: "beach.png",
        mtimeMs: 2,
        size: 20,
      });

      const near = axis(0);
      const far = axis(1);
      store.insertBatch([
        { path: invoice, embedding: near, tags: ["receipt"], width: 100, height: 80 },
        { path: beach, embedding: far },
      ]);

      const lex = store.searchLex("stripe declined", 5);
      expect(lex[0]?.path).toBe(invoice);
      expect(lex[0]?.snippet.toLowerCase()).toContain("stripe");

      const sem = store.searchSem(near, 2);
      expect(sem[0]?.path).toBe(invoice);
      expect(sem[1]?.path).toBe(beach);
    } finally {
      store.close();
    }

    const reopened = await SearchStore.open(memoryPath);
    try {
      expect(reopened.isEmbedded(invoice)).toBe(true);
      expect(reopened.searchLex("invoice", 1)[0]?.path).toBe(invoice);
      expect(reopened.stats().hasVecIndex).toBe(true);
    } finally {
      reopened.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function axis(index: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[index] = 1;
  return vector;
}
