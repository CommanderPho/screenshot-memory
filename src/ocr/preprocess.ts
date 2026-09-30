/**
 * Image preprocessing for OCR
 * Optimizes images for better OCR accuracy and speed
 */

import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { MAX_IMAGE_DIMENSION, MIN_IMAGE_DIMENSION } from "../utils/constants.js";
import type { PreprocessedImage, ImageMetadata } from "./types.js";

/**
 * Preprocess an image for OCR
 * - Resizes large images (faster OCR)
 * - Converts to grayscale (better accuracy)
 * - Normalizes contrast
 */
export async function preprocessImage(imagePath: string): Promise<PreprocessedImage> {
  const image = sharp(imagePath);

  // Get original metadata
  const metadata = await image.metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;

  if (originalWidth < MIN_IMAGE_DIMENSION || originalHeight < MIN_IMAGE_DIMENSION) {
    throw new Error(`Image dimensions (${originalWidth}x${originalHeight}) too small for OCR`);
  }

  // Calculate resize dimensions (keep aspect ratio)
  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (originalWidth > MAX_IMAGE_DIMENSION || originalHeight > MAX_IMAGE_DIMENSION) {
    const scale = Math.min(
      MAX_IMAGE_DIMENSION / originalWidth,
      MAX_IMAGE_DIMENSION / originalHeight
    );
    targetWidth = Math.round(originalWidth * scale);
    targetHeight = Math.round(originalHeight * scale);
  }

  // Process the image
  const processed = await image
    .resize(targetWidth, targetHeight, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.0 })
    .png({ compressionLevel: 1 }) // Fast compression
    .toBuffer();

  return {
    buffer: processed,
    metadata: {
      width: originalWidth,
      height: originalHeight,
      format: metadata.format || "unknown",
      size: metadata.size || 0,
    },
  };
}

/**
 * Preprocess a buffer for OCR
 */
export async function preprocessBuffer(buffer: Buffer): Promise<PreprocessedImage> {
  const image = sharp(buffer);
  const metadata = await image.metadata();

  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;

  if (originalWidth < MIN_IMAGE_DIMENSION || originalHeight < MIN_IMAGE_DIMENSION) {
    throw new Error(`Image dimensions (${originalWidth}x${originalHeight}) too small for OCR`);
  }

  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (originalWidth > MAX_IMAGE_DIMENSION || originalHeight > MAX_IMAGE_DIMENSION) {
    const scale = Math.min(
      MAX_IMAGE_DIMENSION / originalWidth,
      MAX_IMAGE_DIMENSION / originalHeight
    );
    targetWidth = Math.round(originalWidth * scale);
    targetHeight = Math.round(originalHeight * scale);
  }

  const processed = await image
    .resize(targetWidth, targetHeight, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.0 })
    .png({ compressionLevel: 1 })
    .toBuffer();

  return {
    buffer: processed,
    metadata: {
      width: originalWidth,
      height: originalHeight,
      format: metadata.format || "unknown",
      size: buffer.length,
    },
  };
}

/**
 * Get image metadata without full processing
 */
export async function getImageMetadata(imagePath: string): Promise<ImageMetadata> {
  const metadata = await sharp(imagePath).metadata();

  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    format: metadata.format || "unknown",
    size: metadata.size || 0,
  };
}

/**
 * Check if an image is valid and readable
 */
export async function isValidImage(imagePath: string): Promise<boolean> {
  try {
    const metadata = await sharp(imagePath).metadata();
    return !!(
      metadata.width &&
      metadata.height &&
      metadata.width >= MIN_IMAGE_DIMENSION &&
      metadata.height >= MIN_IMAGE_DIMENSION
    );
  } catch {
    return false;
  }
}

/**
 * Read image as buffer
 */
export async function readImageBuffer(imagePath: string): Promise<Buffer> {
  return readFile(imagePath);
}
