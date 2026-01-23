/**
 * Logger utility for screenshot-memory
 * Provides consistent, beautiful console output
 */

import chalk from "chalk";
import figures from "figures";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

let currentLevel: LogLevel = "info";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * Set the log level
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Get the current log level
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

/**
 * Log an info message
 */
export function info(message: string, ...args: unknown[]): void {
  if (shouldLog("info")) {
    console.log(chalk.blue(figures.info), message, ...args);
  }
}

/**
 * Log a success message
 */
export function success(message: string, ...args: unknown[]): void {
  if (shouldLog("info")) {
    console.log(chalk.green(figures.tick), message, ...args);
  }
}

/**
 * Log a warning message
 */
export function warn(message: string, ...args: unknown[]): void {
  if (shouldLog("warn")) {
    console.log(chalk.yellow(figures.warning), message, ...args);
  }
}

/**
 * Log an error message
 */
export function error(message: string, ...args: unknown[]): void {
  if (shouldLog("error")) {
    console.error(chalk.red(figures.cross), message, ...args);
  }
}

/**
 * Log a debug message
 */
export function debug(message: string, ...args: unknown[]): void {
  if (shouldLog("debug")) {
    console.log(chalk.gray(figures.pointer), chalk.gray(message), ...args);
  }
}

/**
 * Log a plain message (no icon)
 */
export function log(message: string, ...args: unknown[]): void {
  if (shouldLog("info")) {
    console.log(message, ...args);
  }
}

/**
 * Log a newline
 */
export function newline(): void {
  if (shouldLog("info")) {
    console.log();
  }
}

/**
 * Log a header
 */
export function header(title: string): void {
  if (shouldLog("info")) {
    console.log();
    console.log(chalk.bold.cyan(title));
    console.log(chalk.gray("─".repeat(Math.min(title.length + 4, 60))));
  }
}

/**
 * Log a key-value pair
 */
export function keyValue(key: string, value: unknown): void {
  if (shouldLog("info")) {
    console.log(chalk.gray(`  ${key}:`), chalk.white(String(value)));
  }
}

/**
 * Create a prefixed logger
 */
export function createLogger(prefix: string) {
  const prefixStr = chalk.gray(`[${prefix}]`);
  return {
    info: (msg: string, ...args: unknown[]) =>
      shouldLog("info") && console.log(prefixStr, chalk.blue(figures.info), msg, ...args),
    success: (msg: string, ...args: unknown[]) =>
      shouldLog("info") && console.log(prefixStr, chalk.green(figures.tick), msg, ...args),
    warn: (msg: string, ...args: unknown[]) =>
      shouldLog("warn") && console.log(prefixStr, chalk.yellow(figures.warning), msg, ...args),
    error: (msg: string, ...args: unknown[]) =>
      shouldLog("error") && console.error(prefixStr, chalk.red(figures.cross), msg, ...args),
    debug: (msg: string, ...args: unknown[]) =>
      shouldLog("debug") && console.log(prefixStr, chalk.gray(figures.pointer), chalk.gray(msg), ...args),
  };
}

export const logger = {
  info,
  success,
  warn,
  error,
  debug,
  log,
  newline,
  header,
  keyValue,
  setLevel: setLogLevel,
  getLevel: getLogLevel,
  create: createLogger,
};

export default logger;
