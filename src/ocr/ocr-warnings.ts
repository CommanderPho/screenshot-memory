/**
 * Classify Tesseract/Leptonica lines that would otherwise land on the terminal.
 */

const OCR_WARNING =
  /Image too small to scale|Line cannot be recognized|cannot be recognized|min width of/;

/**
 * Drop system chatter that is not tied to a particular image.
 */
export function isBenignOcrNoise(line: string): boolean {
  return (
    line.includes("resolution") ||
    line.includes("dpi") ||
    line.includes("msgtracer") ||
    line.includes("Context leak") ||
    line.includes("Warning:")
  );
}

/**
 * Turn a raw OCR warning into a single display line, or return null when the
 * line should stay off the progress output.
 */
export function formatOcrWarning(line: string): string | null {
  const text = line.replace(/\s+/g, " ").trim();
  if (!text || !OCR_WARNING.test(text)) return null;
  return text.replace(/!+/g, "").replace(/\s{2,}/g, " ").trim();
}
