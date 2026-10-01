import { describe, expect, test } from "bun:test";
import { formatOcrWarning, isBenignOcrNoise } from "./ocr-warnings.js";

describe("formatOcrWarning", () => {
  test("keeps the scale detail and drops the bangs", () => {
    expect(formatOcrWarning("Image too small to scale!! (2x36 vs min width of 3)")).toBe(
      "Image too small to scale (2x36 vs min width of 3)"
    );
  });

  test("keeps an unrecognized line as its own warning", () => {
    expect(formatOcrWarning("Line cannot be recognized!!")).toBe("Line cannot be recognized");
  });

  test("drops dpi chatter", () => {
    expect(formatOcrWarning("Warning: Invalid resolution 0 dpi. Using 70 instead.")).toBeNull();
    expect(isBenignOcrNoise("Warning: Invalid resolution 0 dpi. Using 70 instead.")).toBe(true);
  });
});
