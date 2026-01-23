/**
 * Progress display module
 * Provides beautiful progress bars and spinners
 */

import cliProgress from "cli-progress";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import figures from "figures";

export interface ProgressBarOptions {
  total: number;
  format?: string;
  showETA?: boolean;
  showSpeed?: boolean;
}

/**
 * Create a progress bar for indexing
 */
export function createIndexingProgressBar(options: ProgressBarOptions): cliProgress.SingleBar {
  const format = options.format ||
    `${chalk.cyan("{bar}")} ${chalk.white("{percentage}%")} | ` +
    `${chalk.white("{value}/{total}")} | ` +
    `${chalk.white("ETA: {eta}s")} | ` +
    `${chalk.cyan("{filename}")}`;

  const bar = new cliProgress.SingleBar(
    {
      format,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: true,
      forceRedraw: true,
    },
    cliProgress.Presets.shades_classic
  );

  return bar;
}

/**
 * Create a simple progress bar
 */
export function createSimpleProgressBar(total: number): cliProgress.SingleBar {
  const bar = new cliProgress.SingleBar(
    {
      format: `${chalk.cyan("{bar}")} ${chalk.white("{percentage}%")} | ${chalk.white("{value}/{total}")}`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_classic
  );

  bar.start(total, 0);
  return bar;
}

/**
 * Create a spinner for long-running tasks
 */
export function createSpinner(text: string): Ora {
  return ora({
    text,
    spinner: "dots",
    color: "cyan",
  });
}

/**
 * Progress tracker class for complex operations
 */
export class ProgressTracker {
  private bar: cliProgress.SingleBar | null = null;
  private spinner: Ora | null = null;
  private startTime: number = 0;

  /**
   * Start a new phase with a spinner
   */
  startPhase(_name: string, message: string): void {
    this.stopCurrent();
    this.startTime = Date.now();
    this.spinner = createSpinner(message);
    this.spinner.start();
  }

  /**
   * Start a progress bar phase
   */
  startProgressPhase(_name: string, total: number, message?: string): void {
    this.stopCurrent();
    this.startTime = Date.now();

    if (message) {
      console.log(chalk.white(message));
    }

    this.bar = createIndexingProgressBar({ total });
    this.bar.start(total, 0, { filename: "" });
  }

  /**
   * Update progress
   */
  update(value: number, payload?: Record<string, unknown>): void {
    if (this.bar) {
      this.bar.update(value, payload);
    }
  }

  /**
   * Increment progress
   */
  increment(payload?: object): void {
    if (this.bar) {
      if (payload) {
        this.bar.increment(payload);
      } else {
        this.bar.increment();
      }
    }
  }

  /**
   * Update spinner text
   */
  setText(text: string): void {
    if (this.spinner) {
      this.spinner.text = text;
    }
  }

  /**
   * Stop current progress indicator
   */
  stopCurrent(): void {
    if (this.bar) {
      this.bar.stop();
      this.bar = null;
    }
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  /**
   * Mark phase as successful
   */
  succeed(message?: string): void {
    if (this.spinner) {
      this.spinner.succeed(message);
      this.spinner = null;
    } else if (this.bar) {
      this.bar.stop();
      this.bar = null;
      if (message) {
        console.log(chalk.green(`${figures.tick} ${message}`));
      }
    }
  }

  /**
   * Mark phase as failed
   */
  fail(message?: string): void {
    if (this.spinner) {
      this.spinner.fail(message);
      this.spinner = null;
    } else if (this.bar) {
      this.bar.stop();
      this.bar = null;
      if (message) {
        console.log(chalk.red(`${figures.cross} ${message}`));
      }
    }
  }

  /**
   * Mark phase as warning
   */
  warn(message?: string): void {
    if (this.spinner) {
      this.spinner.warn(message);
      this.spinner = null;
    } else if (this.bar) {
      this.bar.stop();
      this.bar = null;
      if (message) {
        console.log(chalk.yellow(`${figures.warning} ${message}`));
      }
    }
  }

  /**
   * Get elapsed time for current phase
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Format elapsed time
   */
  getElapsedFormatted(): string {
    const ms = this.getElapsedMs();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format duration in milliseconds to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Format number with commas
 */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}
