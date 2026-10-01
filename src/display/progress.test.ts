import { describe, expect, test } from "bun:test";
import { indexingRate } from "./progress.js";

describe("indexingRate", () => {
  test("uses the full count when every completion is measured work", () => {
    const result = indexingRate({
      value: 396,
      total: 10078,
      elapsedMs: 19100,
      throughput: 396,
    });

    expect(result.rate).toBeCloseTo(396 / 19.1, 5);
    expect(result.rateLabel).toBe("21/s");
    expect(result.etaLabel).toBe("7m 46s");
  });

  test("ignores already-done files that are in the bar but not in throughput", () => {
    const withReuse = indexingRate({
      value: 396,
      total: 10078,
      elapsedMs: 19100,
      throughput: 46,
    });
    const inflated = indexingRate({
      value: 396,
      total: 10078,
      elapsedMs: 19100,
      throughput: 396,
    });

    expect(withReuse.rate).toBeCloseTo(46 / 19.1, 5);
    expect(withReuse.rateLabel).toBe("2.4/s");
    expect(withReuse.rate).toBeLessThan(inflated.rate);
    expect(withReuse.etaLabel).not.toBe(inflated.etaLabel);
  });

  test("shows an unknown rate until measured work exists", () => {
    const result = indexingRate({
      value: 396,
      total: 10078,
      elapsedMs: 19100,
      throughput: 0,
    });

    expect(result.rate).toBe(0);
    expect(result.rateLabel).toBe("--/s");
    expect(result.etaLabel).toBe("--");
  });

  test("falls back to the displayed count when throughput is omitted", () => {
    const result = indexingRate({
      value: 396,
      total: 10078,
      elapsedMs: 19100,
    });

    expect(result.rateLabel).toBe("21/s");
    expect(result.etaLabel).toBe("7m 46s");
  });
});
