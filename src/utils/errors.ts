/**
 * Custom error classes for screenshot-memory
 */

export class ScreenshotMemoryError extends Error {
  public readonly code: string;
  public readonly suggestion?: string;

  constructor(message: string, code: string, suggestion?: string) {
    super(message);
    this.name = "ScreenshotMemoryError";
    this.code = code;
    this.suggestion = suggestion;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigError extends ScreenshotMemoryError {
  constructor(message: string, suggestion?: string) {
    super(message, "CONFIG_ERROR", suggestion);
    this.name = "ConfigError";
  }
}

export class OcrError extends ScreenshotMemoryError {
  public readonly imagePath?: string;

  constructor(message: string, imagePath?: string, suggestion?: string) {
    super(message, "OCR_ERROR", suggestion);
    this.name = "OcrError";
    this.imagePath = imagePath;
  }
}

export class IndexError extends ScreenshotMemoryError {
  constructor(message: string, suggestion?: string) {
    super(message, "INDEX_ERROR", suggestion);
    this.name = "IndexError";
  }
}

export class SearchError extends ScreenshotMemoryError {
  constructor(message: string, suggestion?: string) {
    super(message, "SEARCH_ERROR", suggestion);
    this.name = "SearchError";
  }
}

export class MemoryError extends ScreenshotMemoryError {
  constructor(message: string, suggestion?: string) {
    super(message, "MEMORY_ERROR", suggestion);
    this.name = "MemoryError";
  }
}

export class FileNotFoundError extends ScreenshotMemoryError {
  public readonly filePath: string;

  constructor(filePath: string) {
    super(`File not found: ${filePath}`, "FILE_NOT_FOUND", "Check if the file exists and the path is correct.");
    this.name = "FileNotFoundError";
    this.filePath = filePath;
  }
}

export class DirectoryNotFoundError extends ScreenshotMemoryError {
  public readonly dirPath: string;

  constructor(dirPath: string) {
    super(`Directory not found: ${dirPath}`, "DIR_NOT_FOUND", "Check if the directory exists and the path is correct.");
    this.name = "DirectoryNotFoundError";
    this.dirPath = dirPath;
  }
}

export class NoScreenshotsFoundError extends ScreenshotMemoryError {
  public readonly dirPath: string;

  constructor(dirPath: string) {
    super(
      `No screenshots found in: ${dirPath}`,
      "NO_SCREENSHOTS",
      "Make sure the directory contains PNG, JPG, or other supported image files."
    );
    this.name = "NoScreenshotsFoundError";
    this.dirPath = dirPath;
  }
}

export class MemoryNotInitializedError extends ScreenshotMemoryError {
  constructor() {
    super(
      "Memory not initialized. Please run 'screenshot-memory index' first.",
      "MEMORY_NOT_INITIALIZED",
      "Run 'ssm index ~/Screenshots' to index your screenshots first."
    );
    this.name = "MemoryNotInitializedError";
  }
}

export class CapacityExceededError extends ScreenshotMemoryError {
  constructor() {
    super(
      "Memory capacity exceeded.",
      "CAPACITY_EXCEEDED",
      "Contact support or upgrade your plan."
    );
    this.name = "CapacityExceededError";
  }
}

/**
 * Handle errors gracefully and return user-friendly messages
 */
export function formatError(err: unknown): { message: string; suggestion?: string } {
  if (err instanceof ScreenshotMemoryError) {
    return {
      message: err.message,
      suggestion: err.suggestion,
    };
  }

  if (err instanceof Error) {
    // Handle known memvid errors
    if (err.message.includes("MV001") || err.message.includes("Capacity")) {
      return {
        message: "Memory capacity exceeded.",
        suggestion: "Contact support or upgrade your plan.",
      };
    }

    if (err.message.includes("MV007") || err.message.includes("locked")) {
      return {
        message: "Memory file is locked by another process.",
        suggestion: "Close other instances of screenshot-memory or wait and try again.",
      };
    }

    if (err.message.includes("ENOENT")) {
      return {
        message: "File or directory not found.",
        suggestion: "Check if the path exists and is accessible.",
      };
    }

    if (err.message.includes("EACCES") || err.message.includes("EPERM")) {
      return {
        message: "Permission denied.",
        suggestion: "Check file permissions or run with appropriate privileges.",
      };
    }

    return {
      message: err.message,
    };
  }

  return {
    message: String(err),
  };
}

/**
 * Check if error is recoverable (can retry)
 */
export function isRecoverableError(err: unknown): boolean {
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout")
    );
  }
  return false;
}
